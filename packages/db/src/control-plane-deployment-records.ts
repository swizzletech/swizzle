import { and, desc, eq } from "drizzle-orm";
import { auditEventsOf } from "./audit.js";
import { listAutomationAudit, recordDeploymentChange } from "./audit-resources.js";

import type { DatabaseClient } from "./client.js";

import { mapDeploymentRow } from "./control-plane-read-models.js";
import type {
  CreateDeploymentAuditEventInput,
  FindSecretDeclarationCollisionsInput,
  SecretDeclarationCollision,
  StoredDeployment,
} from "./control-plane-types.js";
import { automationNamed, automations, automationVersions, deployments } from "./schema.js";

export async function createDeploymentAuditEvent(
  client: DatabaseClient,
  input: CreateDeploymentAuditEventInput,
): Promise<void> {
  await recordDeploymentChange(client.db, input);
}

export async function listDeploymentsByAutomationSlug(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
): Promise<readonly StoredDeployment[]> {
  const rows = await client.db
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
    .where(and(automationNamed(automationSlug), eq(deployments.environment, environment)))
    .orderBy(desc(deployments.deployedAt));

  return rows.map(mapDeploymentRow);
}

export async function listDeploymentsForArtifactRetention(
  client: DatabaseClient,
  environment: string,
): Promise<readonly StoredDeployment[]> {
  const rows = await client.db
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
    .where(eq(deployments.environment, environment))
    .orderBy(desc(deployments.deployedAt));

  return rows.map(mapDeploymentRow);
}

/** The deployment each automation runs, in every environment, newest first. */
export async function listActiveDeployments(
  client: DatabaseClient,
): Promise<readonly StoredDeployment[]> {
  const rows = await client.db
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
    .where(eq(deployments.status, "active"))
    .orderBy(desc(deployments.deployedAt));

  return rows.map(mapDeploymentRow);
}

export async function listDeploymentAuditEventsByAutomationSlug(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
  limit = 50,
) {
  return auditEventsOf(
    "deployment",
    await listAutomationAudit(client, automationSlug, environment, "deployment", limit),
  );
}

export async function findSecretDeclarationCollisions(
  client: DatabaseClient,
  input: FindSecretDeclarationCollisionsInput,
): Promise<readonly SecretDeclarationCollision[]> {
  const uniqueSecretNames = Array.from(new Set(input.secretNames));
  if (uniqueSecretNames.length === 0) {
    return [];
  }

  const rows = await client.db
    .select({
      automationName: automations.name,
      automationSlug: automations.slug,
      config: automationVersions.config,
    })
    .from(deployments)
    .innerJoin(automations, eq(deployments.automationId, automations.id))
    .innerJoin(automationVersions, eq(deployments.versionId, automationVersions.id))
    .where(
      and(
        eq(deployments.environment, input.environment),
        eq(deployments.status, "active"),
        eq(automations.projectId, input.projectId),
      ),
    );

  const bySecret = new Map<
    string,
    { automationNames: Set<string>; automationSlugs: Set<string> }
  >();
  for (const row of rows) {
    if (row.automationSlug === input.excludeAutomationSlug) {
      continue;
    }

    const declaredSecrets = new Set((row.config as { secrets?: readonly string[] }).secrets ?? []);
    for (const secretName of uniqueSecretNames) {
      if (!declaredSecrets.has(secretName)) {
        continue;
      }

      const entry = bySecret.get(secretName) ?? {
        automationNames: new Set<string>(),
        automationSlugs: new Set<string>(),
      };
      entry.automationNames.add(row.automationName);
      entry.automationSlugs.add(row.automationSlug);
      bySecret.set(secretName, entry);
    }
  }

  return [...bySecret.entries()]
    .map(([secretName, entry]) => ({
      automationNames: [...entry.automationNames].sort((left, right) => left.localeCompare(right)),
      automationSlugs: [...entry.automationSlugs].sort((left, right) => left.localeCompare(right)),
      secretName,
    }))
    .sort((left, right) => left.secretName.localeCompare(right.secretName));
}

export async function getActiveDeploymentBySlug(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
): Promise<StoredDeployment | null> {
  const [row] = await client.db
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
    .limit(1);

  return row ? mapDeploymentRow(row) : null;
}
