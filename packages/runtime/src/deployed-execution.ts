import { writeFile } from "node:fs/promises";
import path from "node:path";
import { stringifyAutomationConfig } from "@swizzle/config";
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
  readonly redacted: readonly string[];
}

export interface PreparedExecution {
  readonly options: RunAutomationOptions;
  readonly redacted: readonly string[];
  readonly connectionUsages: readonly StoredConnectionUsage[];
  readonly secretUsages: readonly StoredSecretUsage[];
}

export async function prepareDeployedExecution<T>(
  input: {
    readonly deployment: DeployedVersion;
    readonly environment: NodeJS.ProcessEnv;
    readonly links?: Readonly<Record<string, string>>;
    readonly recordConnectionUsages?: (
      connections: readonly ResolvedConnectionToken[],
    ) => Promise<void>;
    readonly recordSecretUsages: (secrets: readonly ResolvedSecret[]) => Promise<void>;
    readonly secretNames: readonly string[];
    readonly store: ControlPlaneStore;
  },
  use: (prepared: PreparedDeployment) => Promise<T>,
): Promise<T> {
  const { deployment, store } = input;
  return await withDeployedSource(deployment, input.environment, async (directory) => {
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

export async function readDeployedSource(
  deployment: ArtifactStorageReference & Pick<StoredDeployment, "config">,
  environment: NodeJS.ProcessEnv,
): Promise<ExecutionSource> {
  return await withDeployedSource(deployment, environment, readExecutionSource);
}

async function withDeployedSource<T>(
  deployment: ArtifactStorageReference & Pick<StoredDeployment, "config">,
  environment: NodeJS.ProcessEnv,
  use: (directory: string) => Promise<T>,
): Promise<T> {
  return await createArtifactStorageForReference(deployment, { environment }).withSourceDirectory(
    deployment,
    async (directory) => {
      await writeFile(
        path.join(directory, "config.yaml"),
        stringifyAutomationConfig(deployment.config),
      );
      return await use(directory);
    },
  );
}
