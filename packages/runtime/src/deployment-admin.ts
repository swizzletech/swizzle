import type { AutomationConfig } from "@swizzle/config";
import { createDisplayName } from "@swizzle/core";
import {
  CodedError,
  type ControlPlaneStore,
  type DeleteAutomationResult as DbDeleteAutomationResult,
  type DeleteAutomationArtifactRef,
  type DeleteProjectInput,
  type DeleteProjectResult,
  type MovedAutomation,
  type StoredDeployment,
  type WorkerRegistry,
  workerReaches,
  workerReachesEnvironment,
} from "@swizzle/db";

import { AutomationRuntimeError, getErrorMessage } from "./errors.js";
import { getDeploymentConnectionHealth, revokeDeletedConnection } from "./platform-connections.js";
import type {
  DeleteAutomationResultRecord,
  DeleteProjectResultRecord,
  PlatformDeploymentRecord,
  ReadinessWorker,
  RuntimeReadinessReport,
} from "./platform-records.js";
import { getDeploymentSecretHealth } from "./platform-secrets.js";
import {
  addCredentialIssues,
  createQueueNameForProfile,
  evaluateAutomationReadiness,
  gapsInWords,
  workerGaps,
} from "./runtime-requirements.js";
import { createArtifactStorageForReference } from "./storage.js";

/** Lists registered groups and measured online capabilities, or the local executor itself. */
export type ListReadinessWorkers = (input: {
  readonly projectId: string;
  readonly config: AutomationConfig;
  readonly environment: string;
}) => Promise<readonly ReadinessWorker[]>;

interface DeploymentReadinessInput {
  readonly config: AutomationConfig;
  readonly directory: string;
  readonly grantMaxTimeoutMs?: number | null;
  readonly workers: readonly ReadinessWorker[];
}

/** What `workers`, the ones serving the target project and environment, say about a deployment. */
export function evaluateDeploymentReadiness(
  input: DeploymentReadinessInput,
): RuntimeReadinessReport {
  return evaluateAutomationReadiness(
    { config: input.config, directory: input.directory },
    input.workers,
    input.grantMaxTimeoutMs !== undefined ? { grantMaxTimeoutMs: input.grantMaxTimeoutMs } : {},
  );
}

/** Refuses a deployment its workers are not ready for, naming each worker's gaps. */
export function assertDeploymentRuntimeReadiness(
  input: DeploymentReadinessInput,
  readiness: RuntimeReadinessReport = evaluateDeploymentReadiness(input),
): void {
  const { workers } = input;
  if (readiness.status !== "ready") {
    // `workers` serve the target project and environment; only those in the automation's group
    // can take its runs. Each is named below with its gaps, so the per-worker errors are not
    // repeated. With none in the group, the group error alone says what to change.
    const { profile } = input.config.runtime;
    const members = workers.filter((worker) =>
      worker.profiles.some(({ name }) => name === profile),
    );
    const workerDetails =
      members.length > 0
        ? ` Workers in group "${profile}" here: ${members
            .map(
              (worker) =>
                `${worker.name} ${gapsInWords(workerGaps(input.config.runtime, worker))}.`,
            )
            .join(" ")}`
        : "";
    const automationIssues = readiness.errors.filter((issue) => issue.worker === undefined);
    const summary =
      automationIssues.length > 0
        ? automationIssues.map((issue) => issue.message).join(" ")
        : `No worker in group "${profile}" meets every requirement.`;
    // A deployed run never sees the worker's own PATH, so neither the author nor the automation
    // can supply a missing binary.
    const binaryRemedy = readiness.errors.some(
      (issue) => issue.code === "BINARY_REQUIREMENT_MISSING",
    )
      ? ` A deployed run has only the binaries of its worker's runner image; ${
          input.config.runtime.container?.base_image
            ? `add the missing binary to the selected image "${input.config.runtime.container.base_image}" and regenerate /etc/swizzle/runner-tools.json after the final tool install.`
            : "to add Debian packages, set SWIZZLE_RUNNER_APT_PACKAGES in .env and run `just stack`."
        }`
      : "";
    throw new AutomationRuntimeError(
      "RUNTIME_REQUIREMENTS_UNMET",
      `${summary}${workerDetails}${binaryRemedy}`,
      { details: { readiness } },
    );
  }
}

export async function getDeploymentOrThrow(
  store: ControlPlaneStore,
  automationName: string,
  environment: string,
): Promise<StoredDeployment> {
  const automationSlug = createDisplayName(automationName);
  const deployment = await store.getActiveDeploymentBySlug(automationSlug, environment);

  if (deployment === null) {
    throw new AutomationRuntimeError(
      "ACTIVE_DEPLOYMENT_NOT_FOUND",
      `No active deployment found for automation: ${automationName}`,
    );
  }

  return deployment;
}

export async function performRollback(input: {
  readonly artifactsDirectory?: string;
  readonly automationName: string;
  readonly environment: string;
  readonly listReadinessWorkers: ListReadinessWorkers;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly store: ControlPlaneStore;
  readonly targetDeploymentId: string;
}): Promise<PlatformDeploymentRecord> {
  // A rollback runs from its target's artifact tree, and retention sweeps one environment
  // at a time, so a target from another environment could lose the tree the rollback uses.
  const targetDeployment = await input.store.getDeploymentById(input.targetDeploymentId);
  if (
    targetDeployment === null ||
    targetDeployment.automationSlug !== createDisplayName(input.automationName) ||
    targetDeployment.environment !== input.environment
  ) {
    throw new AutomationRuntimeError(
      "DEPLOYMENT_NOT_FOUND",
      `Target deployment not found for ${input.automationName} in ${input.environment}: ${input.targetDeploymentId}`,
    );
  }

  await validateArtifactExists(
    targetDeployment,
    input.artifactsDirectory,
    input.processEnvironment,
  );

  const workers = await input.listReadinessWorkers({
    projectId: targetDeployment.projectId,
    config: targetDeployment.config,
    environment: targetDeployment.environment,
  });

  let newDeployment: StoredDeployment;
  try {
    const commit = await input.store.commitRollbackDeployment({
      auditEvent: {
        eventType: "rollback",
        metadata: {
          targetDeploymentId: input.targetDeploymentId,
        },
      },
      environment: input.environment,
      targetDeploymentId: input.targetDeploymentId,
    });
    newDeployment = commit.deployment;
  } catch (error) {
    if (error instanceof CodedError && error.code === "TRIGGER_WEBHOOK_PATH_CONFLICT") {
      throw new AutomationRuntimeError("ROLLBACK_CONFLICT", error.message, {
        cause: error,
      });
    }
    throw error;
  }

  return await enrichDeploymentRecord(input.store, newDeployment, workers);
}

/** Deletes an automation in every environment; see ControlPlaneStore.deleteAutomation. */
export async function performDeleteAutomation(input: {
  readonly artifactsDirectory?: string;
  readonly automationName: string;
  readonly environment: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly store: ControlPlaneStore;
}): Promise<DeleteAutomationResultRecord> {
  const automationSlug = createDisplayName(input.automationName);
  let result: DbDeleteAutomationResult;
  try {
    result = await input.store.deleteAutomation({
      automationSlug,
      environment: input.environment,
    });
  } catch (error) {
    throw lifecycleError(error);
  }

  const artifactError = await removeAutomationArtifacts({
    ...input,
    automationSlug,
    references: result.artifactReferences,
  });

  return {
    artifactError,
    artifactsRemoved: artifactError === null,
    automationId: result.automationId,
    automationName: result.automationName,
    automationSlug: result.automationSlug,
    deletedCounts: result.deletedCounts,
    environment: input.environment,
    kept: result.kept,
    projectId: result.projectId,
  };
}

/**
 * Deletes a project; see ControlPlaneStore.deleteProject. Then removes each deleted automation's
 * artifact trees and revokes each deleted connection at its provider, both best-effort: the
 * records are already gone, and the first artifact error is reported.
 */
export async function performDeleteProject(input: {
  readonly artifactsDirectory?: string;
  readonly delete: DeleteProjectInput;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly store: ControlPlaneStore;
}): Promise<DeleteProjectResultRecord> {
  let result: DeleteProjectResult;
  try {
    result = await input.store.deleteProject(input.delete);
  } catch (error) {
    throw lifecycleError(error);
  }
  const { deletedAutomations, deletedConnections, ...record } = result;
  let artifactError: string | null = null;
  for (const automation of deletedAutomations) {
    const error = await removeAutomationArtifacts({
      ...input,
      automationSlug: automation.automationSlug,
      references: automation.artifactReferences,
    });
    artifactError ??= error;
  }
  await Promise.all(deletedConnections.map(revokeDeletedConnection));
  return { ...record, artifactError };
}

/** Removes an automation's artifact trees; the error message when that failed, else null. */
async function removeAutomationArtifacts(input: {
  readonly artifactsDirectory?: string;
  readonly automationSlug: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly references: readonly DeleteAutomationArtifactRef[];
}): Promise<string | null> {
  const [first] = input.references;
  if (first === undefined) return null;
  try {
    const storage = createArtifactStorageForReference(
      { ...first, manifestPath: "", sourceDirectory: "" },
      {
        ...(input.artifactsDirectory !== undefined
          ? { artifactsDirectory: input.artifactsDirectory }
          : {}),
        ...(input.processEnvironment !== undefined
          ? { environment: input.processEnvironment }
          : {}),
      },
    );
    await storage.deleteAutomationArtifacts(input.automationSlug);
    return null;
  } catch (error) {
    return getErrorMessage(error);
  }
}

/** Moves an automation to another project; see ControlPlaneStore.moveAutomation. */
export async function performMoveAutomation(input: {
  readonly automationName: string;
  readonly projectId: string;
  readonly store: ControlPlaneStore;
}): Promise<MovedAutomation> {
  try {
    return await input.store.moveAutomation({
      automationSlug: createDisplayName(input.automationName),
      projectId: input.projectId,
    });
  } catch (error) {
    throw lifecycleError(error);
  }
}

function lifecycleError(error: unknown): unknown {
  if (error instanceof CodedError && error.code === "AUTOMATION_NOT_FOUND") {
    return new AutomationRuntimeError("AUTOMATION_NOT_FOUND", error.message, { cause: error });
  }
  if (
    error instanceof CodedError &&
    (error.code === "AUTOMATION_NOT_PAUSED" || error.code === "AUTOMATION_RUNS_ACTIVE")
  ) {
    return new AutomationRuntimeError(error.code, error.message, {
      cause: error,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  }
  return error;
}

export async function enrichDeploymentRecord(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
  workers: readonly ReadinessWorker[],
): Promise<PlatformDeploymentRecord> {
  const [secretHealth, connectionHealth, timeoutGrant] = await Promise.all([
    getDeploymentSecretHealth({
      deployment,
      store,
    }),
    getDeploymentConnectionHealth({
      deployment,
      store,
    }),
    store.getAutomationTimeoutGrant({
      automationId: deployment.automationId,
      environment: deployment.environment,
    }),
  ]);

  return {
    ...deployment,
    connectionHealth,
    readiness: addCredentialIssues(
      evaluateAutomationReadiness(
        { config: deployment.config, directory: deployment.sourceDirectory },
        workers,
        { grantMaxTimeoutMs: timeoutGrant?.maxTimeoutMs ?? null },
      ),
      { connections: connectionHealth, environment: deployment.environment, secrets: secretHealth },
    ),
    secretHealth,
  };
}

export async function checkDatabaseReadiness(
  store: ControlPlaneStore,
): Promise<{ readonly error?: string; readonly ok: boolean }> {
  try {
    await store.listSecrets("__readiness_probe__", []);
    return { ok: true };
  } catch (error) {
    return { error: getErrorMessage(error), ok: false };
  }
}

async function validateArtifactExists(
  deployment: Pick<
    StoredDeployment,
    "artifactBackend" | "artifactLocator" | "artifactRootPath" | "manifestPath" | "sourceDirectory"
  >,
  artifactsDirectory?: string,
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  const storage = createArtifactStorageForReference(deployment, {
    ...(artifactsDirectory !== undefined ? { artifactsDirectory } : {}),
    ...(environment !== undefined ? { environment } : {}),
  });
  await storage.validateDeploymentArtifacts(deployment);
}

/** A registered worker as readiness sees it. */
export interface RegisteredReadinessWorker extends ReadinessWorker {
  /** The projects the worker serves in this environment; the local worker serves every one. */
  readonly projectIds: readonly string[] | "all";
}

const NO_CAPABILITIES = {
  languages: [],
  binaries: [],
  executionModes: [],
  dependencyPackaging: { node: false, python: false },
} as const satisfies ReadinessWorker["capabilities"];

/**
 * The unrevoked workers that reach an environment, or one project of it. Grants come from the
 * registry; capabilities count only while the worker is online, so a sleeping group stays valid
 * without inventing what it can run.
 */
export async function listRegisteredReadinessWorkers(
  registry: Pick<WorkerRegistry, "list">,
  environment: string,
  projectId?: string,
): Promise<readonly RegisteredReadinessWorker[]> {
  return (await registry.list())
    .filter(
      (worker) =>
        worker.state !== "revoked" &&
        (projectId === undefined
          ? workerReachesEnvironment(worker.environments, environment)
          : workerReaches(worker.environments, { projectId, environment })),
    )
    .map((worker): RegisteredReadinessWorker => {
      const online = worker.state === "online" && worker.capabilities !== null;
      return {
        availability: online ? "online" : "offline",
        capabilities: (online ? worker.capabilities : null) ?? NO_CAPABILITIES,
        concurrency: worker.capacity,
        instanceId: worker.id,
        name: worker.name,
        profiles: worker.profiles.map((name) => ({
          name,
          queueName: createQueueNameForProfile(name),
        })),
        projectIds:
          worker.environments === "all"
            ? "all"
            : worker.environments
                .filter((grant) => grant.environment === environment)
                .map((grant) => grant.projectId),
        services: worker.services,
      };
    });
}
