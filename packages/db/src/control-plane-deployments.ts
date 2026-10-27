import { and, desc, eq, sql } from "drizzle-orm";
import { recordDeploymentChange } from "./audit-resources.js";
import type { DatabaseClient } from "./client.js";
import { CodedError } from "./coded-error.js";
import { syncDeploymentCheckInTransaction } from "./control-plane-checks.js";
import {
  copyDeploymentCredentials,
  insertDeploymentCredentials,
} from "./control-plane-credentials.js";

import {
  getChainSourceAutomationIds,
  mapDeploymentRow,
  mapTriggerRow,
  triggerProjection,
} from "./control-plane-read-models.js";
import type {
  CommitDeploymentInput,
  CommitDeploymentResult,
  CommitRollbackDeploymentInput,
  CreateDeploymentAuditEventInput,
  DeploymentTriggerInput,
  PersistDeploymentInput,
  PlatformTriggerStatus,
  StoredDeployment,
  StoredTrigger,
} from "./control-plane-types.js";
import { isDeploymentUnchanged } from "./deployment-comparison.js";
import { computeDeploymentDiff } from "./deployment-diff.js";
import { buildDeploymentTriggerInput } from "./deployment-trigger-input.js";
import {
  automationNamed,
  automations,
  automationTriggerChainSources,
  automationTriggers,
  automationVersions,
  deployments,
} from "./schema.js";

type ControlPlaneTransaction = Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0];

function buildStoredDeploymentFromPersistInput(
  input: PersistDeploymentInput,
  automationId: string,
  seq: number,
  versionId: string,
): StoredDeployment {
  return {
    artifactBackend: input.artifactBackend,
    artifactLocator: input.artifactLocator,
    artifactRootPath: input.artifactRootPath,
    automationId,
    automationName: input.automationName,
    automationSlug: input.automationSlug,
    buildSnapshot: input.buildSnapshot,
    config: input.config,
    deployedAt: input.deployedAt,
    deploymentId: input.deploymentId,
    entrypoint: input.entrypoint,
    environment: input.environment,
    manifestPath: input.manifestPath,
    projectId: input.projectId,
    runtimeSnapshot: input.runtimeSnapshot,
    seq,
    sourceDirectory: input.sourceDirectory,
    sourceHash: input.sourceHash,
    status: "active",
    triggerType: input.config.trigger.type,
    version: input.config.version,
    versionId,
  };
}

function buildRollbackDeployment(
  targetDeployment: StoredDeployment,
  environment: string,
  seq: number,
): StoredDeployment {
  return {
    ...targetDeployment,
    deployedAt: new Date().toISOString(),
    deploymentId: crypto.randomUUID(),
    environment,
    seq,
    status: "active",
  };
}

async function lockAutomationInTransaction(
  tx: ControlPlaneTransaction,
  automationId: string,
): Promise<void> {
  await tx
    .select({ id: automations.id })
    .from(automations)
    .where(eq(automations.id, automationId))
    .limit(1)
    .for("update");
}

async function getNextDeploymentSeqInTransaction(
  tx: ControlPlaneTransaction,
  automationId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      seq: sql<number>`coalesce(max(${deployments.seq}), 0) + 1`,
    })
    .from(deployments)
    .where(eq(deployments.automationId, automationId));

  return row?.seq ?? 1;
}

function configHashSql(config: PersistDeploymentInput["config"]) {
  return sql<string>`md5(${JSON.stringify(config)}::jsonb::text)`;
}

export async function commitDeployment(
  client: DatabaseClient,
  input: CommitDeploymentInput,
): Promise<CommitDeploymentResult> {
  try {
    return await client.db.transaction(async (tx) => {
      const [existingAutomation] = await tx
        .select({
          id: automations.id,
          projectId: automations.projectId,
        })
        .from(automations)
        .where(automationNamed(input.deployment.automationSlug))
        .limit(1)
        .for("update");
      if (
        existingAutomation !== undefined &&
        existingAutomation.projectId !== input.deployment.projectId
      ) {
        throw projectMismatch(input.deployment.automationSlug);
      }

      let automationId = existingAutomation?.id;
      if (automationId === undefined) {
        const insertedAutomations = await tx
          .insert(automations)
          .values({
            description: input.deployment.config.description ?? null,
            name: input.deployment.automationName,
            projectId: input.deployment.projectId,
            slug: input.deployment.automationSlug,
            status: "active",
          })
          .returning({ id: automations.id });
        const insertedAutomation = insertedAutomations[0];
        if (!insertedAutomation) {
          throw new Error("Failed to insert automation.");
        }
        automationId = insertedAutomation.id;
      } else {
        await tx
          .update(automations)
          .set({
            description: input.deployment.config.description ?? null,
            name: input.deployment.automationName,
            status: "active",
            updatedAt: new Date(input.deployment.deployedAt),
          })
          .where(eq(automations.id, automationId));
      }

      await lockAutomationInTransaction(tx, automationId);

      const previousDeployment = await getActiveDeploymentBySlugInTransaction(
        tx,
        input.deployment.automationSlug,
        input.deployment.environment,
      );

      if (
        input.intent === "deploy" &&
        isDeploymentUnchanged(input.deployment, previousDeployment)
      ) {
        return {
          action: "noop",
          deployment: previousDeployment,
          message: `no source or config change — active deployment #${previousDeployment.seq} unchanged`,
          previousDeployment,
          trigger: await getActiveTriggerByAutomationInTransaction(
            tx,
            previousDeployment.automationId,
            previousDeployment.environment,
          ),
        };
      }

      const [existingVersion] = await tx
        .select({
          id: automationVersions.id,
        })
        .from(automationVersions)
        .where(
          and(
            eq(automationVersions.automationId, automationId),
            eq(automationVersions.version, input.deployment.config.version),
            eq(automationVersions.sourceHash, input.deployment.sourceHash),
            eq(automationVersions.configHash, configHashSql(input.deployment.config)),
          ),
        )
        .limit(1);

      let versionId = existingVersion?.id;
      if (versionId === undefined) {
        const insertedVersions = await tx
          .insert(automationVersions)
          .values({
            automationId,
            config: input.deployment.config,
            configHash: configHashSql(input.deployment.config),
            entrypoint: input.deployment.entrypoint,
            sourceHash: input.deployment.sourceHash,
            version: input.deployment.config.version,
          })
          .returning({ id: automationVersions.id });
        const insertedVersion = insertedVersions[0];
        if (!insertedVersion) {
          throw new Error("Failed to insert automation version.");
        }
        versionId = insertedVersion.id;
      }

      const seq = await getNextDeploymentSeqInTransaction(tx, automationId);

      await tx
        .update(deployments)
        .set({ status: "inactive" })
        .where(
          and(
            eq(deployments.automationId, automationId),
            eq(deployments.environment, input.deployment.environment),
            eq(deployments.status, "active"),
          ),
        );

      await tx.insert(deployments).values({
        artifactBackend: input.deployment.artifactBackend,
        artifactLocator: input.deployment.artifactLocator,
        artifactRootPath: input.deployment.artifactRootPath,
        automationId,
        buildSnapshot: input.deployment.buildSnapshot,
        deployedAt: new Date(input.deployment.deployedAt),
        environment: input.deployment.environment,
        id: input.deployment.deploymentId,
        manifestPath: input.deployment.manifestPath,
        runtimeSnapshot: input.deployment.runtimeSnapshot,
        seq,
        sourceDirectory: input.deployment.sourceDirectory,
        status: "active",
        versionId,
      });
      await insertDeploymentCredentials(tx, input.deployment.deploymentId, input.credentials);

      const deployment = buildStoredDeploymentFromPersistInput(
        input.deployment,
        automationId,
        seq,
        versionId,
      );
      const triggerInput = await buildDeploymentTriggerInput(deployment, {
        getActiveDeploymentBySlug: async (slug, environment) =>
          await getActiveDeploymentBySlugInTransaction(tx, slug, environment),
        getChainTriggersForSource: async (sourceAutomationId, environment) =>
          await getChainTriggersForSourceInTransaction(tx, sourceAutomationId, environment),
      });
      const trigger = await syncDeploymentTriggerInTransaction(tx, triggerInput);
      await syncDeploymentCheckInTransaction(tx, deployment);
      const diff = computeDeploymentDiff(deployment, previousDeployment);

      await insertDeploymentAuditEventInTransaction(tx, {
        automationId: deployment.automationId,
        deploymentId: deployment.deploymentId,
        diff,
        environment: deployment.environment,
        eventType: input.auditEvent.eventType,
        metadata: input.auditEvent.metadata ?? {},
        occurredAt: deployment.deployedAt,
        previousDeploymentId: previousDeployment?.deploymentId ?? null,
        previousSourceHash: previousDeployment?.sourceHash ?? null,
        previousVersion: previousDeployment?.version ?? null,
        sourceHash: deployment.sourceHash,
        version: deployment.version,
      });

      return {
        action: previousDeployment === null ? "create" : "update",
        deployment,
        message: null,
        previousDeployment,
        trigger,
      };
    });
  } catch (error) {
    if (isWebhookPathConflict(error)) {
      throw new CodedError(
        "TRIGGER_WEBHOOK_PATH_CONFLICT",
        `Webhook path is already claimed in environment ${input.deployment.environment}: ${
          input.deployment.config.trigger.type === "webhook"
            ? input.deployment.config.trigger.path
            : ""
        }`,
        { cause: error },
      );
    }

    throw error;
  }
}

export async function commitRollbackDeployment(
  client: DatabaseClient,
  input: CommitRollbackDeploymentInput,
): Promise<CommitDeploymentResult> {
  try {
    return await client.db.transaction(async (tx) => {
      const targetDeployment = await getDeploymentByIdInTransaction(tx, input.targetDeploymentId);
      if (targetDeployment === null) {
        throw new CodedError(
          "DEPLOYMENT_NOT_FOUND",
          `Target deployment not found: ${input.targetDeploymentId}`,
        );
      }

      await lockAutomationInTransaction(tx, targetDeployment.automationId);

      const previousDeployment = await getActiveDeploymentBySlugInTransaction(
        tx,
        targetDeployment.automationSlug,
        input.environment,
      );

      await tx
        .update(deployments)
        .set({ status: "inactive" })
        .where(
          and(
            eq(deployments.automationId, targetDeployment.automationId),
            eq(deployments.environment, input.environment),
            eq(deployments.status, "active"),
          ),
        );

      const seq = await getNextDeploymentSeqInTransaction(tx, targetDeployment.automationId);
      const deployment = buildRollbackDeployment(targetDeployment, input.environment, seq);
      await tx.insert(deployments).values({
        artifactBackend: deployment.artifactBackend,
        artifactLocator: deployment.artifactLocator,
        artifactRootPath: deployment.artifactRootPath,
        automationId: deployment.automationId,
        buildSnapshot: deployment.buildSnapshot,
        deployedAt: new Date(deployment.deployedAt),
        environment: deployment.environment,
        id: deployment.deploymentId,
        manifestPath: deployment.manifestPath,
        runtimeSnapshot: deployment.runtimeSnapshot,
        seq: deployment.seq,
        sourceDirectory: deployment.sourceDirectory,
        status: "active",
        versionId: deployment.versionId,
      });
      await copyDeploymentCredentials(tx, targetDeployment.deploymentId, deployment.deploymentId);

      const triggerInput = await buildDeploymentTriggerInput(deployment, {
        getActiveDeploymentBySlug: async (slug, environment) =>
          await getActiveDeploymentBySlugInTransaction(tx, slug, environment),
        getChainTriggersForSource: async (sourceAutomationId, environment) =>
          await getChainTriggersForSourceInTransaction(tx, sourceAutomationId, environment),
      });
      const trigger = await syncDeploymentTriggerInTransaction(tx, triggerInput);
      await syncDeploymentCheckInTransaction(tx, deployment);
      const diff = computeDeploymentDiff(deployment, previousDeployment);

      await insertDeploymentAuditEventInTransaction(tx, {
        automationId: deployment.automationId,
        deploymentId: deployment.deploymentId,
        diff,
        environment: deployment.environment,
        eventType: input.auditEvent.eventType,
        metadata: input.auditEvent.metadata ?? {},
        occurredAt: deployment.deployedAt,
        previousDeploymentId: previousDeployment?.deploymentId ?? null,
        previousSourceHash: previousDeployment?.sourceHash ?? null,
        previousVersion: previousDeployment?.version ?? null,
        sourceHash: deployment.sourceHash,
        version: deployment.version,
      });

      return {
        action: "update",
        deployment,
        message: null,
        previousDeployment,
        trigger,
      };
    });
  } catch (error) {
    if (isWebhookPathConflict(error)) {
      throw new CodedError(
        "TRIGGER_WEBHOOK_PATH_CONFLICT",
        `Webhook path is already claimed in environment ${input.environment}`,
        { cause: error },
      );
    }

    throw error;
  }
}

async function getDeploymentByIdInTransaction(
  tx: ControlPlaneTransaction,
  deploymentId: string,
): Promise<StoredDeployment | null> {
  const [row] = await tx
    .select({
      artifactBackend: deployments.artifactBackend,
      artifactLocator: deployments.artifactLocator,
      artifactRootPath: deployments.artifactRootPath,
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
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  return row ? mapDeploymentRow(row) : null;
}

async function getActiveDeploymentBySlugInTransaction(
  tx: ControlPlaneTransaction,
  automationSlug: string,
  environment: string,
): Promise<StoredDeployment | null> {
  const [row] = await tx
    .select({
      artifactBackend: deployments.artifactBackend,
      artifactLocator: deployments.artifactLocator,
      artifactRootPath: deployments.artifactRootPath,
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
    .where(
      and(
        automationNamed(automationSlug),
        eq(deployments.environment, environment),
        eq(deployments.status, "active"),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .limit(1)
    .for("share", { of: automations });

  return row ? mapDeploymentRow(row) : null;
}

async function getTriggerByIdInTransaction(
  tx: ControlPlaneTransaction,
  triggerId: string,
): Promise<StoredTrigger | null> {
  const [row] = await tx
    .select(triggerProjection)
    .from(automationTriggers)
    .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
    .innerJoin(automationVersions, eq(automationTriggers.versionId, automationVersions.id))
    .where(eq(automationTriggers.id, triggerId))
    .limit(1);

  if (!row) {
    return null;
  }

  return mapTriggerRow({
    ...row,
    chainSourceAutomationIds: await getChainSourceAutomationIds(tx, triggerId),
  });
}

async function getActiveTriggerByAutomationInTransaction(
  tx: ControlPlaneTransaction,
  automationId: string,
  environment: string,
): Promise<StoredTrigger | null> {
  const [row] = await tx
    .select(triggerProjection)
    .from(automationTriggers)
    .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
    .innerJoin(automationVersions, eq(automationTriggers.versionId, automationVersions.id))
    .where(
      and(
        eq(automationTriggers.automationId, automationId),
        eq(automationTriggers.environment, environment),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  return mapTriggerRow({
    ...row,
    chainSourceAutomationIds: await getChainSourceAutomationIds(tx, row.triggerId),
  });
}

async function syncDeploymentTriggerInTransaction(
  tx: ControlPlaneTransaction,
  input: DeploymentTriggerInput,
): Promise<StoredTrigger> {
  const [existingTrigger] = await tx
    .select({
      id: automationTriggers.id,
      pausedAt: automationTriggers.pausedAt,
      status: automationTriggers.status,
      webhookPath: automationTriggers.webhookPath,
    })
    .from(automationTriggers)
    .where(
      and(
        eq(automationTriggers.automationId, input.automationId),
        eq(automationTriggers.environment, input.environment),
      ),
    )
    .limit(1);

  const desiredStatus: PlatformTriggerStatus =
    input.errorCode !== null && input.errorCode !== undefined
      ? "invalid"
      : existingTrigger?.status === "paused"
        ? "paused"
        : "active";

  const normalizedWebhookPath = input.triggerType === "webhook" ? input.webhookPath : null;
  if (normalizedWebhookPath !== null) {
    const [conflictingTrigger] = await tx
      .select({ id: automationTriggers.id })
      .from(automationTriggers)
      .where(
        and(
          eq(automationTriggers.environment, input.environment),
          eq(automationTriggers.webhookPath, normalizedWebhookPath),
        ),
      )
      .limit(1);
    if (conflictingTrigger && conflictingTrigger.id !== existingTrigger?.id) {
      throw new CodedError(
        "TRIGGER_WEBHOOK_PATH_CONFLICT",
        `Webhook path is already claimed in environment ${input.environment}: ${normalizedWebhookPath}`,
      );
    }
  }

  const values: typeof automationTriggers.$inferInsert = {
    automationId: input.automationId,
    chainOnStatus: input.triggerType === "chain" ? input.chainOnStatus : null,
    chainPayloadMode: input.triggerType === "chain" ? input.chainPayloadMode : null,
    chainSourceAutomationId: input.triggerType === "chain" ? input.chainSourceAutomationId : null,
    cronIntervalMs: input.triggerType === "cron" ? input.cronIntervalMs : null,
    cronSchedule: input.triggerType === "cron" ? input.cronSchedule : null,
    deploymentId: input.deploymentId,
    environment: input.environment,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    nextRunAt:
      input.triggerType === "cron" && input.nextRunAt !== null ? new Date(input.nextRunAt) : null,
    pausedAt:
      desiredStatus === "paused" ? (existingTrigger?.pausedAt ?? new Date(input.updatedAt)) : null,
    status: desiredStatus,
    triggerType: input.triggerType,
    updatedAt: new Date(input.updatedAt),
    versionId: input.versionId,
    webhookPath: normalizedWebhookPath,
  };

  const triggerId = existingTrigger
    ? (
        await tx
          .update(automationTriggers)
          .set(values)
          .where(eq(automationTriggers.id, existingTrigger.id))
          .returning({ id: automationTriggers.id })
      )[0]?.id
    : (
        await tx
          .insert(automationTriggers)
          .values({
            ...values,
            createdAt: new Date(input.updatedAt),
          })
          .returning({ id: automationTriggers.id })
      )[0]?.id;

  if (!triggerId) {
    throw new Error("Failed to persist automation trigger.");
  }

  await tx
    .delete(automationTriggerChainSources)
    .where(eq(automationTriggerChainSources.triggerId, triggerId));

  const chainSourceAutomationIds =
    input.triggerType === "chain" ? input.chainSourceAutomationIds : [];
  if (chainSourceAutomationIds.length > 0) {
    await tx.insert(automationTriggerChainSources).values(
      chainSourceAutomationIds.map((sourceAutomationId) => ({
        sourceAutomationId,
        triggerId,
      })),
    );
  }

  const trigger = await getTriggerByIdInTransaction(tx, triggerId);
  if (trigger === null) {
    throw new Error(`Persisted trigger could not be reloaded: ${triggerId}`);
  }

  return trigger;
}

async function insertDeploymentAuditEventInTransaction(
  tx: ControlPlaneTransaction,
  input: CreateDeploymentAuditEventInput,
): Promise<void> {
  await recordDeploymentChange(tx, input);
}

function isWebhookPathConflict(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint" in current &&
      current.constraint === "automation_triggers_webhook_path_unique"
    ) {
      return true;
    }
  }
  return false;
}

async function getChainTriggersForSourceInTransaction(
  tx: ControlPlaneTransaction,
  sourceAutomationId: string,
  environment: string,
): Promise<readonly { readonly automationId: string }[]> {
  const singleSourceDownstreamTriggers = await tx
    .select({ automationId: automationTriggers.automationId })
    .from(automationTriggers)
    .where(
      and(
        eq(automationTriggers.chainSourceAutomationId, sourceAutomationId),
        eq(automationTriggers.environment, environment),
        eq(automationTriggers.triggerType, "chain"),
        eq(automationTriggers.status, "active"),
      ),
    );

  const multiSourceDownstreamTriggers = await tx
    .select({ automationId: automationTriggers.automationId })
    .from(automationTriggerChainSources)
    .innerJoin(
      automationTriggers,
      eq(automationTriggerChainSources.triggerId, automationTriggers.id),
    )
    .where(
      and(
        eq(automationTriggerChainSources.sourceAutomationId, sourceAutomationId),
        eq(automationTriggers.environment, environment),
        eq(automationTriggers.triggerType, "chain"),
        eq(automationTriggers.status, "active"),
      ),
    );

  return [...singleSourceDownstreamTriggers, ...multiSourceDownstreamTriggers];
}

function projectMismatch(automationSlug: string): CodedError {
  return new CodedError(
    "AUTOMATION_PROJECT_MISMATCH",
    `Automation ${automationSlug} belongs to another project; deploy it to its own project or choose another name.`,
  );
}
