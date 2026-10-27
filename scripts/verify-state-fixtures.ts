import { randomUUID } from "node:crypto";
import type { AutomationConfig } from "@swizzle/config";
import {
  type ControlPlaneStore,
  DEFAULT_PROJECT_ID,
  type DeploymentCredential,
  type PersistDeploymentInput,
  type StoredDeployment,
} from "@swizzle/db";

export async function commitDeploymentFixture(
  store: ControlPlaneStore,
  automationName: string,
  projectId: string = DEFAULT_PROJECT_ID,
  environment = "state-machine",
  credentials: readonly DeploymentCredential[] = [],
  trigger?: AutomationConfig["trigger"],
): Promise<StoredDeployment> {
  const deployedAt = new Date().toISOString();
  const deploymentId = randomUUID();
  // The config declares what the deployment binds, as a real deploy finds it.
  const named = (kind: "connection" | "secret") =>
    credentials.flatMap(({ credential }) => (credential.kind === kind ? [credential.name] : []));
  const base = createConfig(automationName, "1.0.0");
  const config = {
    ...base,
    connections: named("connection"),
    secrets: named("secret"),
    trigger: trigger ?? base.trigger,
  };
  const deployment = await store.commitDeployment({
    intent: "deploy",
    auditEvent: {
      eventType: "deploy",
      metadata: { verification: "state-machine" },
    },
    credentials,
    deployment: {
      projectId,
      artifactBackend: "local",
      artifactLocator: {
        artifactsDirectory: "/tmp/swizzle-state-machine-artifacts",
        relativeRootPath: `${automationName}/1.0.0/source`,
        type: "local",
      },
      artifactRootPath: `/tmp/swizzle-state-machine-artifacts/${automationName}/1.0.0`,
      automationName,
      automationSlug: automationName,
      buildSnapshot: createBuildSnapshot(deployedAt),
      config,
      deployedAt,
      deploymentId,
      environment,
      entrypoint: "main.js",
      manifestPath: `/tmp/swizzle-state-machine-artifacts/${automationName}/1.0.0/deployment.json`,
      runtimeSnapshot: config.runtime,
      sourceDirectory: `/tmp/swizzle-state-machine-source/${automationName}`,
      sourceHash: `state-machine-${automationName}-${randomUUID()}`,
    },
  });

  return deployment.deployment;
}

export async function createQueuedRun(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
  runId: string,
  queueJobId: string,
  payload: Record<string, unknown>,
  options: {
    readonly chainOriginRunId?: string | null;
    readonly chainSourceRunIds?: readonly string[];
    readonly invokeDepth?: number;
    readonly parentRunId?: string | null;
    readonly parentStepKey?: string | null;
    readonly triggerType?: "chain" | "cron" | "webhook";
  } = {},
): Promise<void> {
  await store.createRun({
    attemptsMax: 1,
    automationId: deployment.automationId,
    ...(options.chainOriginRunId !== undefined
      ? { chainOriginRunId: options.chainOriginRunId }
      : {}),
    chainSourceRunIds: options.chainSourceRunIds ?? [],
    deploymentId: deployment.deploymentId,
    ...(options.invokeDepth !== undefined ? { invokeDepth: options.invokeDepth } : {}),
    payload,
    ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
    ...(options.parentStepKey !== undefined ? { parentStepKey: options.parentStepKey } : {}),
    queueJobId,
    queueName: "platform-runs:state-machine",
    runId,
    triggerType: options.triggerType ?? "webhook",
    versionId: deployment.versionId,
  });
}

export function createConfig(name: string, version: string): AutomationConfig {
  return {
    connections: [],
    entrypoint: "main.js",
    name,
    runtime: {
      execution_mode: "host",
      language: "node",
      on_overlap: "queue",
      permissions: {
        services: [],
        network: true,
        writable_dirs: [],
      },
      profile: "host-default",
      rate_limits: {},
      requirements: {
        binaries: [],
      },
      retry: {
        backoff: "fixed",
        max_attempts: 1,
      },
      queue_timeout: "24h",
      timeout: "60s",
    },
    secrets: [],
    trigger: {
      path: `/${name}`,
      type: "webhook",
    },
    vars: {},
    version,
  };
}

export function createBuildSnapshot(packagedAt: string): PersistDeploymentInput["buildSnapshot"] {
  return {
    stepSites: [],
    packagedAt,
    status: "not-required",
    steps: [],
  };
}
