// The preparation a deployed run execution and a deployed API check share: a copy of the deployed
// source, the timeout grant, the secrets and connection tokens the process receives, the record
// of which ones it used, and the values to redact. prepareRunExecution and prepareCheckExecution call
// prepareDeployedExecution when a worker claims the execution, hand the options to the worker, and
// build the delivery within the source copy scope.
import type {
  ControlPlaneStore,
  ResolvedSecret,
  StoredConnectionUsage,
  StoredDeployment,
  StoredSecretUsage,
} from "@swizzle/db";

import { readExecutionSource } from "./execution-wire.js";
import {
  type ResolvedConnectionToken,
  resolveRequiredConnections,
} from "./platform-connections.js";
import { buildPlatformChildEnvironment, resolveRequiredSecrets } from "./platform-secrets.js";
import type { ExecutionOptions, RunAutomationOptions } from "./runner.js";
import { type ArtifactStorageReference, createArtifactStorageForReference } from "./storage.js";
import { SWIZZLE_LINK_KEY_ENV } from "./wait-links.js";
import type { ExecutionSource } from "./worker-wire.js";

/** The deployed version an execution runs: a run's or a check's deployment. */
/**
 * What a process executes. Its `projectId` names whose secrets it receives: a run's own project,
 * which stays the run's after a move, or for a check the project its automation is in now.
 */
export type DeployedVersion = ArtifactStorageReference &
  Pick<
    StoredDeployment,
    | "automationId"
    | "automationName"
    | "config"
    | "deploymentId"
    | "environment"
    | "projectId"
    | "version"
    | "versionId"
  >;

interface PreparedDeployment {
  readonly options: Required<
    Pick<
      ExecutionOptions,
      | "automationDirectory"
      | "environment"
      | "environmentName"
      | "grantMaxTimeoutMs"
      | "policyEnvironment"
      | "runtimeMetadata"
    >
  >;
  /** Every injected secret, connection token and link key: what the redactor hides. */
  readonly redacted: readonly string[];
}

/** A claimed execution the server prepared: the worker's options and what the server keeps. */
export interface PreparedExecution {
  readonly options: RunAutomationOptions;
  readonly redacted: readonly string[];
  /** A check writes these with its outcome; a run recorded them on its execution when prepared. */
  readonly connectionUsages: readonly StoredConnectionUsage[];
  readonly secretUsages: readonly StoredSecretUsage[];
}

/**
 * Resolves the deployment options and calls use while its private source copy exists.
 * Copy, preparation, and callback failures all leave the same cleanup scope.
 */
export async function prepareDeployedExecution<T>(
  input: {
    readonly deployment: DeployedVersion;
    /** The server's environment: the storage and timeout settings. None of it reaches the child. */
    readonly environment: NodeJS.ProcessEnv;
    /** A run's SWIZZLE_LINK_URL and SWIZZLE_LINK_KEY; a check signs no links. */
    readonly links?: Readonly<Record<string, string>>;
    readonly recordConnectionUsages?: (
      connections: readonly ResolvedConnectionToken[],
    ) => Promise<void>;
    readonly recordSecretUsages: (secrets: readonly ResolvedSecret[]) => Promise<void>;
    /** The secrets the executed script declares. */
    readonly secretNames: readonly string[];
    readonly store: ControlPlaneStore;
  },
  use: (prepared: PreparedDeployment) => Promise<T>,
): Promise<T> {
  const { deployment, store } = input;
  return await createArtifactStorageForReference(deployment, {
    environment: input.environment,
  }).withSourceDirectory(deployment, async (directory) => {
    const timeoutGrant = await store.getAutomationTimeoutGrant({
      automationId: deployment.automationId,
      environment: deployment.environment,
    });
    const secrets = await resolveRequiredSecrets({
      automationName: deployment.automationName,
      environment: deployment.environment,
      holder: deployment,
      secretNames: input.secretNames,
      store,
    });
    await input.recordSecretUsages(secrets);
    const connections = await resolveRequiredConnections({
      automationName: deployment.automationName,
      connectionNames: deployment.config.connections,
      environment: deployment.environment,
      holder: deployment,
      store,
    });
    await input.recordConnectionUsages?.(connections);

    return await use({
      options: {
        automationDirectory: directory,
        environment: buildPlatformChildEnvironment({
          connections,
          ...(input.links !== undefined ? { links: input.links } : {}),
          secrets,
        }),
        environmentName: deployment.environment,
        grantMaxTimeoutMs: timeoutGrant?.maxTimeoutMs ?? null,
        policyEnvironment: input.environment,
        runtimeMetadata: {
          automationId: deployment.automationId,
          automationName: deployment.automationName,
          version: deployment.version,
          versionId: deployment.versionId,
        },
      },
      redacted: [
        ...secrets.map((secret) => secret.value),
        ...connections.map((connection) => connection.accessToken),
        input.links?.[SWIZZLE_LINK_KEY_ENV] ?? "",
      ].filter((value) => value !== ""),
    });
  });
}

/** The deployed bundle as a worker receives it, read from a fresh copy of the source. */
export async function readDeployedSource(
  deployment: ArtifactStorageReference,
  environment: NodeJS.ProcessEnv,
): Promise<ExecutionSource> {
  return await createArtifactStorageForReference(deployment, {
    environment,
  }).withSourceDirectory(deployment, readExecutionSource);
}
