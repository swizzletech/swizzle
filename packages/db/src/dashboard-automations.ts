import { type AutomationConfig, parseIntervalToMs } from "@swizzle/config";
import { createDisplayName } from "@swizzle/core";
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ReadScope } from "./access.js";
import { untestedThresholdMs } from "./api-check-rules.js";
import type { AuditEventOf } from "./audit.js";
import { auditEventsOf } from "./audit.js";
import { auditEventOf } from "./audit-tables.js";
import type { DatabaseClient } from "./client.js";
import { listApiContacts, listAutomationChecks } from "./control-plane-checks.js";
import { listDeploymentAuditEventsByAutomationSlug } from "./control-plane-deployment-records.js";
import type {
  ConnectionStatus,
  StoredAutomationCheck,
  StoredRuntimeSnapshot,
} from "./control-plane-types.js";
import {
  listLatestRunsByAutomation,
  listObservedInvocations,
  listRecentRunGlances,
} from "./dashboard-runs.js";
import {
  asArtifactStorageBackend,
  asAutomationConfig,
  automationsInScope,
  type ChainSource,
  chainSourcesInScope,
  mapSecretHealth,
  normalizeStoredArtifactLocator,
  ownedInScope,
} from "./dashboard-shared.js";
import type {
  DashboardApiCheck,
  DashboardApiContact,
  DashboardAutomationDetail,
  DashboardAutomationSummary,
  DashboardConnectionStatus,
  DashboardDeploymentChange,
  DashboardDeploymentSummary,
  DashboardTriggerSummary,
} from "./dashboard-types.js";
import { projectRefColumns } from "./project-ref-columns.js";
import {
  auditEvents,
  automationFolders,
  automationNamed,
  automations,
  automationTriggerChainSources,
  automationTriggers,
  automationVersions,
  credentialShares,
  deploymentCredentials,
  deployments,
  environmentConnections,
  environmentSecrets,
  projects,
} from "./schema.js";

/** How many runs an automation's health strip shows. */
const HEALTH_STRIP_RUNS = 10;
/** How far back child runs count as evidence that one automation invokes another. */
const OBSERVED_INVOCATION_DAYS = 7;

/**
 * The automation as `scope` lets the viewer read it: null outside it, and among what it invokes
 * only the automations the viewer may read too.
 */
export async function getAutomationDetail(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
  scope: ReadScope,
): Promise<DashboardAutomationDetail | null> {
  const [summary] = await listAutomationSummaries(client, environment, scope, [automationSlug]);
  if (summary === undefined) return null;

  const [deploymentAudit, deploymentHistory] = await Promise.all([
    listDeploymentAudit(client, automationSlug, environment, 20),
    listDeploymentHistory(client, automationSlug, environment),
  ]);

  return { ...summary, deploymentAudit, deploymentHistory };
}

export async function listAutomationSummaries(
  client: DatabaseClient,
  environment: string,
  scope: ReadScope,
  automationSlugs?: readonly string[],
): Promise<readonly DashboardAutomationSummary[]> {
  const deploymentFilters = [
    eq(deployments.environment, environment),
    eq(deployments.status, "active"),
    automationsInScope(scope),
  ];
  const includeSpecificAutomations = automationSlugs !== undefined && automationSlugs.length > 0;
  if (includeSpecificAutomations) {
    deploymentFilters.push(inArray(automations.slug, [...automationSlugs]));
  }

  const deploymentRows = await client.db
    .select({
      artifactBackend: deployments.artifactBackend,
      artifactLocator: deployments.artifactLocator,
      artifactRootPath: deployments.artifactRootPath,
      automationDescription: automations.description,
      automationFolderId: automations.folderId,
      automationFolderName: automationFolders.name,
      automationId: automations.id,
      automationName: automations.name,
      automationSlug: automations.slug,
      buildSnapshot: deployments.buildSnapshot,
      config: automationVersions.config,
      deployedAt: deployments.deployedAt,
      deploymentId: deployments.id,
      entrypoint: automationVersions.entrypoint,
      environment: deployments.environment,
      manifestPath: deployments.manifestPath,
      projectId: automations.projectId,
      project: projectRefColumns(projects),
      runtimeSnapshot: deployments.runtimeSnapshot,
      seq: deployments.seq,
      sourceDirectory: deployments.sourceDirectory,
      sourceHash: automationVersions.sourceHash,
      status: deployments.status,
      version: automationVersions.version,
      versionId: automationVersions.id,
    })
    .from(deployments)
    .innerJoin(automations, eq(deployments.automationId, automations.id))
    .innerJoin(projects, eq(automations.projectId, projects.id))
    .leftJoin(automationFolders, eq(automations.folderId, automationFolders.id))
    .innerJoin(automationVersions, eq(deployments.versionId, automationVersions.id))
    .where(and(...deploymentFilters))
    .orderBy(automations.name);

  if (deploymentRows.length === 0) {
    return [];
  }

  const automationIds = deploymentRows.map((row) => row.automationId);
  const deploymentIds = deploymentRows.map((row) => row.deploymentId);
  const chainSourceAutomations = alias(automations, "chain_source_automations");
  const triggerRows = await client.db
    .select({
      automationId: automationTriggers.automationId,
      chainOnStatus: automationTriggers.chainOnStatus,
      chainPayloadMode: automationTriggers.chainPayloadMode,
      // Null unless the trigger has a single source; a join's are in the chain sources table.
      chainSource: {
        automationId: chainSourceAutomations.id,
        name: chainSourceAutomations.name,
        projectId: chainSourceAutomations.projectId,
        slug: chainSourceAutomations.slug,
      },
      cronIntervalMs: automationTriggers.cronIntervalMs,
      cronSchedule: automationTriggers.cronSchedule,
      deploymentId: automationTriggers.deploymentId,
      environment: automationTriggers.environment,
      errorCode: automationTriggers.errorCode,
      errorMessage: automationTriggers.errorMessage,
      nextRunAt: automationTriggers.nextRunAt,
      pausedAt: automationTriggers.pausedAt,
      status: automationTriggers.status,
      triggerId: automationTriggers.id,
      triggerType: automationTriggers.triggerType,
      updatedAt: automationTriggers.updatedAt,
      versionId: automationTriggers.versionId,
      webhookPath: automationTriggers.webhookPath,
    })
    .from(automationTriggers)
    .leftJoin(
      chainSourceAutomations,
      eq(chainSourceAutomations.id, automationTriggers.chainSourceAutomationId),
    )
    .where(
      and(
        eq(automationTriggers.environment, environment),
        inArray(automationTriggers.automationId, automationIds),
      ),
    );

  const triggerIds = triggerRows.map((row) => row.triggerId);
  const chainSourceRows =
    triggerIds.length > 0
      ? await client.db
          .select({
            automationId: chainSourceAutomations.id,
            name: chainSourceAutomations.name,
            projectId: chainSourceAutomations.projectId,
            slug: chainSourceAutomations.slug,
            triggerId: automationTriggerChainSources.triggerId,
          })
          .from(automationTriggerChainSources)
          .innerJoin(
            chainSourceAutomations,
            eq(chainSourceAutomations.id, automationTriggerChainSources.sourceAutomationId),
          )
          .where(inArray(automationTriggerChainSources.triggerId, triggerIds))
      : [];

  const chainSourcesByTriggerId = new Map<string, ChainSource[]>();
  for (const { triggerId, ...source } of chainSourceRows) {
    chainSourcesByTriggerId.set(triggerId, [
      ...(chainSourcesByTriggerId.get(triggerId) ?? []),
      source,
    ]);
  }

  const [latestRuns, recentRuns, observedInvocations, connections, checks, contacts] =
    await Promise.all([
      listLatestRunsByAutomation(client, environment, automationIds),
      listRecentRunGlances(client, environment, automationIds, HEALTH_STRIP_RUNS),
      listObservedInvocations(
        client,
        environment,
        new Date(Date.now() - OBSERVED_INVOCATION_DAYS * 24 * 60 * 60_000),
        scope,
      ),
      listBoundConnections(client, deploymentIds),
      listAutomationChecks(client, environment, automationIds),
      listApiContacts(client, environment, automationIds),
    ]);
  const checksByAutomationId = new Map(checks.map((check) => [check.automationId, check]));
  const contactsByAutomationId = new Map<string, DashboardApiContact[]>();
  for (const { automationId, environment: _environment, ...contact } of contacts) {
    const list = contactsByAutomationId.get(automationId) ?? [];
    list.push(contact);
    contactsByAutomationId.set(automationId, list);
  }
  const [secrets, deployable] = await Promise.all([
    listBoundSecrets(client, deploymentIds),
    listDeployableCredentials(client, environment, [
      ...new Set(deploymentRows.map((row) => row.projectId)),
    ]),
  ]);
  const secretsByDeploymentId = byDeployment(secrets);
  const connectionsByDeploymentId = byDeployment(connections);
  const triggersByAutomationId = new Map(triggerRows.map((row) => [row.automationId, row]));
  const latestRunsByAutomationId = new Map(latestRuns.map((row) => [row.automationId, row]));
  const invokedByParentSlug = new Map<string, string[]>();
  for (const { childSlug, parentSlug } of observedInvocations) {
    invokedByParentSlug.set(parentSlug, [
      ...(invokedByParentSlug.get(parentSlug) ?? []),
      childSlug,
    ]);
  }

  const visibleTargets = includeSpecificAutomations
    ? await client.db
        .select({ automationName: automations.name, automationSlug: automations.slug })
        .from(deployments)
        .innerJoin(automations, eq(deployments.automationId, automations.id))
        .where(
          and(
            eq(deployments.environment, environment),
            eq(deployments.status, "active"),
            automationsInScope(scope),
          ),
        )
    : deploymentRows;
  const slugByName = new Map(visibleTargets.map((row) => [row.automationName, row.automationSlug]));

  return deploymentRows.map((row) => {
    const config = asAutomationConfig(row.config);
    const trigger = triggersByAutomationId.get(row.automationId);
    const chainSources = trigger
      ? chainSourcesInScope(
          trigger.chainSource,
          (chainSourcesByTriggerId.get(trigger.triggerId) ?? []).toSorted((a, b) => {
            const order =
              config.trigger.type === "chain"
                ? (config.trigger.sources ?? []).map(createDisplayName)
                : [];
            return order.indexOf(a.slug) - order.indexOf(b.slug);
          }),
          scope,
        )
      : { hidden: 0, names: [], slugs: [] };
    // A run receives what its deployment bound and its automation's project still holds.
    const holds = (bound: BoundCredentialRow) =>
      bound.projectId === row.projectId || bound.shareProjectId === row.projectId;
    const deployableHere = (kind: "connection" | "secret") => (name: string) =>
      deployable.has(JSON.stringify([kind, row.projectId, name]));
    const requiredSecrets = mapSecretHealth(
      config.secrets,
      environment,
      new Map(
        (secretsByDeploymentId.get(row.deploymentId) ?? []).flatMap((secret) =>
          holds(secret) ? [[secret.name, secret]] : [],
        ),
      ),
      deployableHere("secret"),
    );
    const connectionsByName = new Map(
      (connectionsByDeploymentId.get(row.deploymentId) ?? []).flatMap((connection) =>
        holds(connection) ? [[connection.name, connection] as const] : [],
      ),
    );
    const requiredConnections = config.connections.map((name): DashboardConnectionStatus => {
      const connection = connectionsByName.get(name);
      return {
        name,
        provider: connection?.provider ?? null,
        status:
          (connection?.status as ConnectionStatus | undefined) ??
          (deployableHere("connection")(name) ? "unbound" : "missing"),
      };
    });

    return {
      activeDeployment: {
        artifactBackend: asArtifactStorageBackend(row.artifactBackend),
        artifactLocator: normalizeStoredArtifactLocator(
          row.artifactBackend,
          row.artifactLocator,
          row.artifactRootPath,
        ),
        artifactRootPath: row.artifactRootPath,
        buildSnapshot: row.buildSnapshot,
        deployedAt: row.deployedAt.toISOString(),
        deploymentId: row.deploymentId,
        entrypoint: row.entrypoint,
        environment: row.environment,
        manifestPath: row.manifestPath,
        runtimeSnapshot: row.runtimeSnapshot as StoredRuntimeSnapshot,
        seq: row.seq,
        sourceDirectory: row.sourceDirectory,
        sourceHash: row.sourceHash,
        status: row.status,
        triggerType: config.trigger.type,
        vars: { ...config.vars },
        version: row.version,
        versionId: row.versionId,
      },
      apiCheck: dashboardApiCheck(config, checksByAutomationId.get(row.automationId), {
        deployedAt: row.deployedAt,
        trigger: trigger ?? null,
      }),
      apiContacts: contactsByAutomationId.get(row.automationId) ?? [],
      automationId: row.automationId,
      automationName: row.automationName,
      automationSlug: row.automationSlug,
      description: row.automationDescription ?? config.description ?? null,
      environment: row.environment,
      folderId: row.automationFolderId,
      folderName: row.automationFolderName,
      invokesAutomationSlugs: [
        ...new Set([
          ...(invokedByParentSlug.get(row.automationSlug) ?? []),
          ...row.buildSnapshot.stepSites.flatMap((site) =>
            site.target === null ? [] : (slugByName.get(site.target) ?? []),
          ),
        ]),
      ].sort(),
      lastRun: latestRunsByAutomationId.get(row.automationId) ?? null,
      projectId: row.projectId,
      project: row.project,
      recentRuns: recentRuns.get(row.automationId) ?? [],
      requiredConnections,
      requiredSecrets,
      trigger: trigger
        ? {
            chainOnStatus: trigger.chainOnStatus,
            chainPayloadMode: trigger.chainPayloadMode,
            chainHiddenSourceCount: chainSources.hidden,
            chainSourceAutomationNames: chainSources.names,
            chainSourceAutomationSlugs: chainSources.slugs,
            cronIntervalMs: trigger.cronIntervalMs,
            cronSchedule: trigger.cronSchedule,
            deploymentId: trigger.deploymentId,
            environment: trigger.environment,
            errorCode: trigger.errorCode,
            errorMessage: trigger.errorMessage,
            nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
            pausedAt: trigger.pausedAt?.toISOString() ?? null,
            status: trigger.status as DashboardTriggerSummary["status"],
            triggerId: trigger.triggerId,
            triggerType: trigger.triggerType as DashboardTriggerSummary["triggerType"],
            updatedAt: trigger.updatedAt.toISOString(),
            versionId: trigger.versionId,
            webhookPath: trigger.webhookPath,
          }
        : null,
    } satisfies DashboardAutomationSummary;
  });
}

function dashboardApiCheck(
  config: AutomationConfig,
  record: StoredAutomationCheck | undefined,
  context: {
    readonly deployedAt: Date;
    readonly trigger: Parameters<typeof untestedThresholdMs>[1];
  },
): DashboardApiCheck | null {
  const apiCheck = config.api_check;
  switch (apiCheck?.mode) {
    case undefined:
      return null;
    case "off":
      return { mode: "off", reason: apiCheck.reason };
    case "passive":
      return {
        mode: "passive",
        untestedAfterMs: untestedThresholdMs(
          apiCheck.untested_after,
          context.trigger,
          context.deployedAt,
        ),
      };
    case "active":
      return {
        entrypoint: apiCheck.entrypoint,
        everyMs: parseIntervalToMs(apiCheck.every),
        mode: "active",
        record:
          record === undefined
            ? null
            : {
                consecutiveFailures: record.consecutiveFailures,
                deploymentId: record.deploymentId,
                failingSince: record.failingSince,
                lastCheckedAt: record.lastCheckedAt,
                lastExitCode: record.lastExitCode,
                lastGreenAt: record.lastGreenAt,
                lastGreenOutput: record.lastGreenOutput,
                lastGreenReport: record.lastGreenReport,
                lastOutput: record.lastOutput,
                lastReport: record.lastReport,
                lastStderrTail: record.lastStderrTail,
                lastWarning: record.lastWarning,
                nextCheckAt: record.nextCheckAt,
                status: record.status,
              },
        secrets: apiCheck.secrets ?? null,
      };
  }
}

async function listDeploymentHistory(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
): Promise<readonly DashboardDeploymentSummary[]> {
  const rows = await client.db
    .select({
      artifactBackend: deployments.artifactBackend,
      artifactLocator: deployments.artifactLocator,
      artifactRootPath: deployments.artifactRootPath,
      buildSnapshot: deployments.buildSnapshot,
      config: automationVersions.config,
      deployedAt: deployments.deployedAt,
      deploymentId: deployments.id,
      entrypoint: automationVersions.entrypoint,
      environment: deployments.environment,
      manifestPath: deployments.manifestPath,
      runtimeSnapshot: deployments.runtimeSnapshot,
      seq: deployments.seq,
      sourceDirectory: deployments.sourceDirectory,
      sourceHash: automationVersions.sourceHash,
      status: deployments.status,
      version: automationVersions.version,
      versionId: automationVersions.id,
    })
    .from(deployments)
    .innerJoin(automations, eq(deployments.automationId, automations.id))
    .innerJoin(automationVersions, eq(deployments.versionId, automationVersions.id))
    .where(and(automationNamed(automationSlug), eq(deployments.environment, environment)))
    .orderBy(desc(deployments.deployedAt));

  return rows.map((row) => {
    const config = asAutomationConfig(row.config);
    return {
      artifactBackend: asArtifactStorageBackend(row.artifactBackend),
      artifactLocator: normalizeStoredArtifactLocator(
        row.artifactBackend,
        row.artifactLocator,
        row.artifactRootPath,
      ),
      artifactRootPath: row.artifactRootPath,
      buildSnapshot: row.buildSnapshot,
      deployedAt: row.deployedAt.toISOString(),
      deploymentId: row.deploymentId,
      entrypoint: row.entrypoint,
      environment: row.environment,
      manifestPath: row.manifestPath,
      runtimeSnapshot: row.runtimeSnapshot as StoredRuntimeSnapshot,
      seq: row.seq,
      sourceDirectory: row.sourceDirectory,
      sourceHash: row.sourceHash,
      status: row.status,
      triggerType: config.trigger.type,
      vars: { ...config.vars },
      version: row.version,
      versionId: row.versionId,
    } satisfies DashboardDeploymentSummary;
  });
}

async function listDeploymentAudit(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
  limit: number,
): Promise<readonly AuditEventOf<"deployment">[]> {
  return listDeploymentAuditEventsByAutomationSlug(client, automationSlug, environment, limit);
}

/** Deploys and rollbacks of every automation in the environment since `since`, newest first. */
export async function listDeploymentChanges(
  client: DatabaseClient,
  environment: string,
  since: Date,
  limit: number,
  scope: ReadScope,
): Promise<readonly DashboardDeploymentChange[]> {
  const rows = await client.db
    .select({
      event: auditEvents,
      automationName: automations.name,
      automationSlug: automations.slug,
    })
    .from(auditEvents)
    .innerJoin(automations, eq(auditEvents.automationId, automations.id))
    .where(
      and(
        eq(auditEvents.environment, environment),
        gte(auditEvents.occurredAt, since),
        sql`${auditEvents.change}->>'kind' = 'deployment'`,
        ownedInScope(scope, auditEvents),
      ),
    )
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(limit);
  return rows.flatMap((row) =>
    auditEventsOf("deployment", [auditEventOf(row.event)]).map((event) => ({
      ...event,
      automationName: row.automationName,
      automationSlug: row.automationSlug,
    })),
  );
}

interface BoundCredentialRow {
  readonly deploymentId: string;
  readonly name: string;
  /** The project that owns the credential. */
  readonly projectId: string;
  /** The project a share bound it into, or null for the owner's own. */
  readonly shareProjectId: string | null;
}

function byDeployment<Row extends { readonly deploymentId: string }>(
  rows: readonly Row[],
): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const group = grouped.get(row.deploymentId);
    if (group === undefined) {
      grouped.set(row.deploymentId, [row]);
    } else {
      group.push(row);
    }
  }
  return grouped;
}

/**
 * What a deploy in these projects would find, as `[kind, projectId, name]` keys: each project's
 * own credentials in the environment and those shared into it.
 */
async function listDeployableCredentials(
  client: DatabaseClient,
  environment: string,
  projectIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const [ownSecrets, ownConnections, shared] = await Promise.all([
    client.db
      .select({ name: environmentSecrets.name, projectId: environmentSecrets.projectId })
      .from(environmentSecrets)
      .where(
        and(
          eq(environmentSecrets.environment, environment),
          inArray(environmentSecrets.projectId, [...projectIds]),
        ),
      ),
    client.db
      .select({ name: environmentConnections.name, projectId: environmentConnections.projectId })
      .from(environmentConnections)
      .where(
        and(
          eq(environmentConnections.environment, environment),
          inArray(environmentConnections.projectId, [...projectIds]),
        ),
      ),
    client.db
      .select({
        connection: environmentConnections.name,
        projectId: credentialShares.projectId,
        secret: environmentSecrets.name,
      })
      .from(credentialShares)
      .leftJoin(environmentSecrets, eq(environmentSecrets.id, credentialShares.secretId))
      .leftJoin(
        environmentConnections,
        eq(environmentConnections.id, credentialShares.connectionId),
      )
      .where(
        and(
          inArray(credentialShares.projectId, [...projectIds]),
          isNotNull(credentialShares.acceptedAt),
          or(
            eq(environmentSecrets.environment, environment),
            eq(environmentConnections.environment, environment),
          ),
        ),
      ),
  ]);
  return new Set([
    ...ownSecrets.map((row) => JSON.stringify(["secret", row.projectId, row.name])),
    ...ownConnections.map((row) => JSON.stringify(["connection", row.projectId, row.name])),
    ...shared.map((row) =>
      row.secret === null
        ? JSON.stringify(["connection", row.projectId, row.connection])
        : JSON.stringify(["secret", row.projectId, row.secret]),
    ),
  ]);
}

/** The secrets these deployments bound, with the projects that may still use them. */
async function listBoundSecrets(client: DatabaseClient, deploymentIds: readonly string[]) {
  if (deploymentIds.length === 0) return [];
  return await client.db
    .select({
      algorithm: environmentSecrets.algorithm,
      createdAt: environmentSecrets.createdAt,
      deploymentId: deploymentCredentials.deploymentId,
      environment: environmentSecrets.environment,
      keyVersion: environmentSecrets.keyVersion,
      name: environmentSecrets.name,
      projectId: environmentSecrets.projectId,
      secretVersion: environmentSecrets.secretVersion,
      shareProjectId: credentialShares.projectId,
      updatedAt: environmentSecrets.updatedAt,
    })
    .from(deploymentCredentials)
    .innerJoin(environmentSecrets, eq(environmentSecrets.id, deploymentCredentials.secretId))
    .leftJoin(credentialShares, eq(credentialShares.id, deploymentCredentials.shareId))
    .where(inArray(deploymentCredentials.deploymentId, [...deploymentIds]));
}

/** The connections these deployments bound, with the projects that may still use them. */
async function listBoundConnections(client: DatabaseClient, deploymentIds: readonly string[]) {
  if (deploymentIds.length === 0) return [];
  return await client.db
    .select({
      deploymentId: deploymentCredentials.deploymentId,
      name: environmentConnections.name,
      projectId: environmentConnections.projectId,
      provider: environmentConnections.provider,
      shareProjectId: credentialShares.projectId,
      status: environmentConnections.status,
    })
    .from(deploymentCredentials)
    .innerJoin(
      environmentConnections,
      eq(environmentConnections.id, deploymentCredentials.connectionId),
    )
    .leftJoin(credentialShares, eq(credentialShares.id, deploymentCredentials.shareId))
    .where(inArray(deploymentCredentials.deploymentId, [...deploymentIds]));
}
