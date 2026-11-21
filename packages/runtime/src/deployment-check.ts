import { createDisplayName } from "@swizzle/core";
import {
  type ControlPlaneStore,
  DEFAULT_PROJECT_ID,
  type DeploymentChange,
  type DeploymentCredential,
  deploymentChanges,
  isDeploymentUnchanged,
  resolveChainSources,
  type StoredDeployment,
} from "@swizzle/db";

import { type DeploymentCandidate, inspectDeploymentCandidate } from "./deploy.js";
import {
  assertDeploymentRuntimeReadiness,
  evaluateDeploymentReadiness,
  type ListReadinessWorkers,
} from "./deployment-admin.js";
import { bindsExactly, findDeclaredCredentials } from "./deployment-credentials.js";
import { AutomationRuntimeError } from "./errors.js";
import type { ReadinessWorker, RuntimeReadinessReport } from "./platform-records.js";
import type { PlatformDeployOptions } from "./platform-types.js";
import { normalizeConfiguredWebhookPath } from "./triggers.js";

interface CheckFacts {
  readonly candidate: DeploymentCandidate;
  readonly automationSlug: string;
  readonly projectId: string;
  readonly credentials: readonly DeploymentCredential[];
  readonly workers: readonly ReadinessWorker[];
  readonly unchanged: boolean;
  readonly changes: readonly DeploymentChange[];
  readonly readiness: RuntimeReadinessReport;
  readonly webhookPath: string | null;
}

export type DeploymentCheck = CheckFacts &
  (
    | { readonly action: "create"; readonly activeDeployment: null }
    | { readonly action: "update" | "noop"; readonly activeDeployment: StoredDeployment }
  );

export async function checkDeployment(
  context: {
    readonly listReadinessWorkers: ListReadinessWorkers;
    readonly store: ControlPlaneStore;
  },
  options: PlatformDeployOptions,
): Promise<DeploymentCheck> {
  const { store } = context;
  const { environment } = options;
  const candidate = await inspectDeploymentCandidate({
    automationDirectory: options.automationDirectory,
    ...(options.skipReadinessCheck ? { skipReadinessCheck: true } : {}),
  });
  if (
    options.expectedSourceHash !== undefined &&
    options.expectedSourceHash !== candidate.sourceHash
  ) {
    throw new AutomationRuntimeError(
      "DEPLOYMENT_CONTENT_HASH_MISMATCH",
      `Bundle content hash mismatch. Client computed ${options.expectedSourceHash} but server computed ${candidate.sourceHash}. Likely cause: an .swizzleignore or IGNORED_DIRECTORY_NAMES drift between CLI and runtime.`,
    );
  }
  const { config } = candidate.definition;
  const webhookPath =
    config.trigger.type === "webhook" ? normalizeConfiguredWebhookPath(config.trigger.path) : null;
  const automationSlug = createDisplayName(config.name);
  const current = await store.findAutomation(automationSlug);
  const projectId =
    (await options.project?.({ automationSlug, current })) ??
    current?.projectId ??
    DEFAULT_PROJECT_ID;
  await resolveChainSources({ config, environment, projectId }, (slug, environment) =>
    store.getActiveDeploymentBySlug(slug, environment),
  );
  if (webhookPath !== null) {
    const holder = await store.getWebhookTriggerByPath(webhookPath, environment);
    if (holder !== null && holder.automationSlug !== automationSlug) {
      throw new AutomationRuntimeError(
        "TRIGGER_WEBHOOK_PATH_CONFLICT",
        `Webhook path is already claimed in environment ${environment}: ${webhookPath}`,
        { details: { path: webhookPath } },
      );
    }
  }
  const activeDeployment = await store.getActiveDeploymentBySlug(automationSlug, environment);
  const credentials = await findDeclaredCredentials({
    config,
    place: { environment, projectId },
    store,
  });
  const unchanged = isDeploymentUnchanged(
    { config, sourceHash: candidate.sourceHash },
    activeDeployment,
  );
  const noop =
    options.force !== true &&
    unchanged &&
    (await bindsExactly(store, { ...activeDeployment, projectId }, credentials));
  if (!noop) await options.credentials?.(credentials, projectId);
  const workers = await context.listReadinessWorkers({ config, environment, projectId });
  const timeoutGrant = activeDeployment
    ? await store.getAutomationTimeoutGrant({
        automationId: activeDeployment.automationId,
        environment,
      })
    : null;
  const readiness = evaluateDeploymentReadiness({
    config,
    directory: candidate.definition.directory,
    grantMaxTimeoutMs: timeoutGrant?.maxTimeoutMs ?? null,
    workers,
  });
  if (!options.skipReadinessCheck) {
    assertDeploymentRuntimeReadiness(
      { config, directory: candidate.definition.directory, workers },
      readiness,
    );
  }
  const facts: CheckFacts = {
    automationSlug,
    candidate,
    changes: deploymentChanges(
      {
        config: candidate.definition.config,
        entrypoint: candidate.definition.entrypointRelativePath,
        sourceHash: candidate.sourceHash,
      },
      activeDeployment,
    ),
    credentials,
    projectId,
    readiness,
    unchanged,
    webhookPath,
    workers,
  };
  return activeDeployment === null
    ? { ...facts, action: "create", activeDeployment }
    : { ...facts, action: noop ? "noop" : "update", activeDeployment };
}
