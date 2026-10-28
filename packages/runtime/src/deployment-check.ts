/**
 * Every check a deployment passes before it builds and commits: the uploaded bundle's hash, its
 * webhook path, the project it lands in and the deployer's right there, its chain sources, the
 * credentials it binds and the deployer's use of them, and whether the workers that would run it are
 * ready for it (unless forced).
 * POST /deployments runs it for every apply. POST /deployment-checks answers with its result
 * instead, which is how `swizzle validate` and `swizzle apply --dry-run` learn whether apply would
 * succeed: one check, so neither can approve what apply refuses.
 */
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

/** A deployment that passed every check apply makes before it builds. */
interface CheckFacts {
  readonly candidate: DeploymentCandidate;
  readonly automationSlug: string;
  readonly projectId: string;
  readonly credentials: readonly DeploymentCredential[];
  readonly workers: readonly ReadinessWorker[];
  /**
   * The source and config match the active deployment. Unless forced, such a deployment is a
   * no-op when it also binds exactly the credentials it bound before (`action` "noop").
   */
  readonly unchanged: boolean;
  readonly changes: readonly DeploymentChange[];
  /** What the workers serving its project say: ready, or not ready and forced past the check. */
  readonly readiness: RuntimeReadinessReport;
  /** The normalized path of its webhook trigger; null for another trigger. */
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
    // The commit refuses the same conflict in its transaction; this answers before the build.
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
  // An unchanged version still deploys again when what it would bind changed, so that setting
  // a deleted secret again and redeploying restores it.
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
  // A per-automation timeout grant raises the effective ceiling for this automation only. It
  // exists only once the automation is registered, so a first deploy gets the global ceiling.
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
