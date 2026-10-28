import { createDisplayName } from "@swizzle/core";
import {
  CodedError,
  type ControlPlaneStore,
  deploymentChanges,
  isFinishedRun,
  isOpenRun,
  placementInWords,
  type RunPlacement,
  type StoredRun,
} from "@swizzle/db";
import { enqueueDueChecks } from "./api-checks.js";
import { deployAutomation } from "./deploy.js";
import {
  enrichDeploymentRecord,
  getDeploymentOrThrow,
  type ListReadinessWorkers,
  performDeleteAutomation,
  performDeleteProject,
  performMoveAutomation,
  performRollback,
} from "./deployment-admin.js";
import { checkDeployment } from "./deployment-check.js";
import { AutomationRuntimeError } from "./errors.js";
import {
  beginPlatformConnectionAuthorization,
  completePlatformConnectionCallback,
  deletePlatformConnection,
  getPlatformConnection,
  listPlatformConnections,
  resolvePlatformConnectionToken,
} from "./platform-connections.js";
import type { CancelRunResult, PlatformReadinessReport } from "./platform-records.js";
import {
  deletePlatformSecret,
  getPlatformSecret,
  listPlatformSecrets,
  upsertPlatformSecret,
} from "./platform-secrets.js";
import type {
  CreateNotificationRuleOptions,
  PlatformServices,
  RunMaintenanceOptions,
} from "./platform-types.js";
import {
  decideWaitingApproval,
  enqueueRunFromDeployment,
  enqueueRunFromTrigger,
  findWaitByLink,
  getRunOrThrow,
  reconcileQueuedRunsWithStore,
  resolveWaitingEventRun,
  resumeDueWaitingRunsWithStore,
} from "./run-lifecycle.js";
import type { RunQueueProducer } from "./run-queue.js";
import {
  getAutomationTrigger as getStoredAutomationTrigger,
  listAutomationTriggerAuditEvents as listStoredAutomationTriggerAuditEvents,
  materializeDueCronRuns as materializeStoredDueCronRuns,
  pauseAutomationTrigger as pauseStoredAutomationTrigger,
  resumeAutomationTrigger as resumeStoredAutomationTrigger,
  startManualRun as startStoredManualRun,
  triggerWebhookByPath as triggerStoredWebhookByPath,
} from "./triggers.js";

export interface CreatePlatformServiceFacadeOptions {
  readonly artifactsDirectory?: string;
  readonly checkReadiness: () => Promise<PlatformReadinessReport>;
  readonly close: () => Promise<void>;
  readonly onRunCancelled?: (runId: string) => Promise<void> | void;
  readonly listReadinessWorkers: ListReadinessWorkers;
  /** Why a queued run waits for a worker; see `PlatformRunDetail`. */
  readonly placeRun: (run: StoredRun) => Promise<RunPlacement | null>;
  readonly queue: RunQueueProducer;
  readonly runMaintenance: (
    options: RunMaintenanceOptions,
  ) => ReturnType<PlatformServices["runMaintenance"]>;
  readonly store: ControlPlaneStore;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  if (normalized <= 0) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      `Expected a positive integer, got: ${value}`,
    );
  }

  return normalized;
}

function normalizeNotificationThreshold(
  eventType: CreateNotificationRuleOptions["eventType"],
  threshold: number | undefined,
): number {
  const fallback = eventType === "repeated-failures" ? 3 : 1;
  return normalizePositiveInteger(threshold, fallback);
}

export function createPlatformServiceFacade(
  options: CreatePlatformServiceFacadeOptions,
): PlatformServices {
  const { queue, store } = options;
  const cancelRunRecursively = async (runId: string, depth = 0): Promise<CancelRunResult> => {
    const run = await getRunOrThrow(store, runId);
    if (isFinishedRun(run.status)) {
      return { alreadyTerminal: true, run };
    }

    if (depth < 8) {
      const children = await store.listChildRuns({ parentRunId: runId });
      for (const child of children) {
        if (isOpenRun(child.status)) {
          await cancelRunRecursively(child.runId, depth + 1);
        }
      }
    }

    const result = await store.cancelRun({ runId, finishedAt: new Date().toISOString() });
    if (!result.alreadyTerminal) await options.onRunCancelled?.(runId);
    return result;
  };

  return {
    beginConnectionAuthorization: async (authorizeOptions) => {
      return await beginPlatformConnectionAuthorization({
        clientId: authorizeOptions.clientId,
        clientSecret: authorizeOptions.clientSecret,
        creator: authorizeOptions.creator,
        name: authorizeOptions.name,
        place: authorizeOptions.place,
        provider: authorizeOptions.provider,
        providerConfig: authorizeOptions.providerConfig,
        publicUrl: authorizeOptions.publicUrl,
        reauthorizes: authorizeOptions.reauthorizes,
        reuseFrom: authorizeOptions.reuseFrom,
        scopes: authorizeOptions.scopes ?? [],
        store,
      });
    },

    completeConnectionCallback: async (callbackOptions) => {
      return await completePlatformConnectionCallback({
        code: callbackOptions.code,
        providerError: callbackOptions.providerError,
        providerFromPath: callbackOptions.providerFromPath,
        state: callbackOptions.state,
        store,
      });
    },

    deleteConnection: async (connectionId) =>
      await deletePlatformConnection({ connectionId, store }),

    getConnection: async (name, place) => await getPlatformConnection({ name, place, store }),

    listConnections: async (environment, projectIds) =>
      await listPlatformConnections({ environment, projectIds, store }),

    testConnection: async (name, place) => {
      const found = await getPlatformConnection({ name, place, store });
      if (found === null) {
        throw new AutomationRuntimeError(
          "CONNECTION_NOT_FOUND",
          `Connection not found in environment ${place.environment}: ${name}`,
        );
      }
      // Force a refresh whenever the token has an expiry, so the probe proves
      // the whole credential chain (client secrets + refresh token) still works.
      const resolved = await resolvePlatformConnectionToken({
        connection: found,
        refreshSkewMs: Number.MAX_SAFE_INTEGER,
        store,
      });
      const connection = (await getPlatformConnection({ name, place, store })) ?? found;
      return {
        accessTokenExpiresAt: resolved.token.accessTokenExpiresAt,
        connection,
        refreshed: resolved.refreshed,
      };
    },

    credentials: store,

    cancelPlatformRun: async (runId) => await cancelRunRecursively(runId),

    checkReadiness: async () => {
      return await options.checkReadiness();
    },

    close: async () => {
      await options.close();
    },

    createNotificationRule: async (ruleOptions) => {
      const { environment } = ruleOptions;
      return await store.createNotificationRule({
        automationId: ruleOptions.automationId,
        channel: "telegram",
        chatId: ruleOptions.chatId.trim(),
        cooldownSeconds: normalizePositiveInteger(ruleOptions.cooldownSeconds, 900),
        enabled: ruleOptions.enabled ?? true,
        environment,
        eventType: ruleOptions.eventType,
        projectId: ruleOptions.projectId,
        threshold: normalizeNotificationThreshold(ruleOptions.eventType, ruleOptions.threshold),
        userId: ruleOptions.userId,
        windowSeconds: normalizePositiveInteger(ruleOptions.windowSeconds, 3600),
      });
    },

    deleteNotificationRule: async (ruleId) => {
      return await store.deleteNotificationRule(ruleId);
    },

    deleteSecret: async (secretId) => {
      return await deletePlatformSecret({ secretId, store });
    },

    findSecretDeclarationCollisions: async (input) => {
      return await store.findSecretDeclarationCollisions({
        environment: input.environment,
        projectId: input.projectId,
        ...(input.excludeAutomationSlug !== undefined
          ? { excludeAutomationSlug: input.excludeAutomationSlug }
          : {}),
        secretNames: input.secretNames,
      });
    },

    checkDeployment: async (deployOptions) => {
      const check = await checkDeployment(
        { listReadinessWorkers: options.listReadinessWorkers, store },
        deployOptions,
      );
      return {
        action: check.action,
        changes: check.changes,
        automationName: check.candidate.definition.config.name,
        environment: deployOptions.environment,
        projectId: check.projectId,
        readiness: check.readiness,
        webhookPath: check.webhookPath,
      };
    },

    findAutomation: async (automationName) =>
      await store.findAutomation(createDisplayName(automationName)),

    moveAutomation: async (automationName, projectId) =>
      await performMoveAutomation({ automationName, projectId, store }),

    deployAutomationToPlatform: async (deployOptions) => {
      const deployEnvironment = deployOptions.environment;
      const check = await checkDeployment(
        { listReadinessWorkers: options.listReadinessWorkers, store },
        deployOptions,
      );
      const { automationSlug, credentials, projectId, workers } = check;
      if (check.action === "noop") {
        const enriched = await enrichDeploymentRecord(store, check.activeDeployment, workers);
        return {
          ...enriched,
          action: "noop",
          changes: check.changes,
          message: `no source or config change, active deployment #${check.activeDeployment.seq} unchanged`,
        };
      }

      const deployment = await deployAutomation({
        ...(deployOptions.artifactsDirectory !== undefined ||
        options.artifactsDirectory !== undefined
          ? {
              artifactsDirectory: deployOptions.artifactsDirectory ?? options.artifactsDirectory,
            }
          : {}),
        automationDirectory: deployOptions.automationDirectory,
        ...(deployOptions.deploymentId !== undefined
          ? { deploymentId: deployOptions.deploymentId }
          : {}),
        ...(deployOptions.skipReadinessCheck ? { skipReadinessCheck: true } : {}),
      });

      // Building can take minutes. Checking again right before the commit means a use revoked
      // meanwhile refuses this deploy, as it would refuse the next one.
      await deployOptions.credentials?.(credentials, projectId);

      try {
        const commit = await store.commitDeployment({
          auditEvent: { eventType: "deploy" },
          credentials,
          deployment: {
            artifactBackend: deployment.artifactBackend,
            artifactLocator: deployment.artifactLocator,
            artifactRootPath: deployment.artifactRootPath,
            automationName: deployment.definition.config.name,
            automationSlug,
            buildSnapshot: deployment.buildSnapshot,
            config: deployment.definition.config,
            deployedAt: deployment.deployedAt,
            deploymentId: deployment.deploymentId,
            environment: deployEnvironment,
            entrypoint: deployment.definition.entrypointRelativePath,
            manifestPath: deployment.manifestPath,
            projectId,
            runtimeSnapshot: deployment.runtimeSnapshot,
            sourceDirectory: deployment.sourceDirectory,
            sourceHash: deployment.sourceHash,
          },
          intent:
            deployOptions.force === true || check.unchanged ? "redeploy-if-unchanged" : "deploy",
        });
        const enriched = await enrichDeploymentRecord(store, commit.deployment, workers);
        return {
          ...enriched,
          action: commit.action,
          changes:
            commit.action === "noop"
              ? []
              : deploymentChanges(commit.deployment, commit.previousDeployment),
          message: commit.message,
        };
      } catch (error) {
        if (
          error instanceof CodedError &&
          (error.code === "AUTOMATION_PROJECT_MISMATCH" ||
            error.code === "DEPLOYMENT_CREDENTIALS_CHANGED" ||
            error.code === "TRIGGER_WEBHOOK_PATH_CONFLICT")
        ) {
          throw new AutomationRuntimeError(error.code, error.message, {
            cause: error,
          });
        }

        throw error;
      }
    },

    enqueuePlatformRun: async (enqueueOptions) => {
      const deployment = await getDeploymentOrThrow(
        store,
        enqueueOptions.automationName,
        enqueueOptions.environment,
      );

      return await enqueueRunFromDeployment({
        deployment,
        payload: enqueueOptions.payload ?? {},
        queue,
        ...(enqueueOptions.runId !== undefined ? { runId: enqueueOptions.runId } : {}),
        store,
        triggerType: enqueueOptions.triggerType ?? deployment.triggerType,
        webhookContext: enqueueOptions.webhookContext ?? null,
      });
    },

    getAutomationDeployment: async (automationName, environment) => {
      const deployment = await getDeploymentOrThrow(store, automationName, environment);

      const workers = await options.listReadinessWorkers({
        config: deployment.config,
        projectId: deployment.projectId,
        environment: deployment.environment,
      });
      return await enrichDeploymentRecord(store, deployment, workers);
    },

    getDeploymentById: async (deploymentId) => {
      const deployment = await store.getDeploymentById(deploymentId);
      if (deployment === null) {
        throw new AutomationRuntimeError(
          "DEPLOYMENT_NOT_FOUND",
          `Deployment not found: ${deploymentId}`,
        );
      }
      const workers = await options.listReadinessWorkers({
        config: deployment.config,
        projectId: deployment.projectId,
        environment: deployment.environment,
      });
      return await enrichDeploymentRecord(store, deployment, workers);
    },

    getLatestMaintenanceRun: async (environment) => {
      return await store.getLatestMaintenanceRun(environment);
    },

    getAutomationTrigger: async (automationName, environment) => {
      return await getStoredAutomationTrigger({
        automationName,
        environment,
        store,
      });
    },

    getPlatformRun: async (runId) => {
      const run = await getRunOrThrow(store, runId);
      const placement = run.status === "queued" ? await options.placeRun(run) : null;
      return {
        ...run,
        placement:
          placement === null ? null : { ...placement, words: placementInWords(placement, run) },
      };
    },

    listAutomationState: async (stateOptions) => {
      const { environment } = stateOptions;
      const deployment = await getDeploymentOrThrow(
        store,
        stateOptions.automationName,
        environment,
      );
      return await store.listAutomationState({
        automationId: deployment.automationId,
        environment,
      });
    },

    getAutomationStateValue: async (stateOptions) => {
      const { environment } = stateOptions;
      const deployment = await getDeploymentOrThrow(
        store,
        stateOptions.automationName,
        environment,
      );
      return await store.getAutomationStateValue({
        automationId: deployment.automationId,
        environment,
        key: stateOptions.key,
      });
    },

    setAutomationStateValue: async (stateOptions) => {
      const { environment } = stateOptions;
      const deployment = await getDeploymentOrThrow(
        store,
        stateOptions.automationName,
        environment,
      );
      return await store.setAutomationStateValue({
        automationId: deployment.automationId,
        environment,
        key: stateOptions.key,
        updatedAt: new Date().toISOString(),
        value: stateOptions.value,
      });
    },

    deleteAutomationStateValue: async (stateOptions) => {
      const { environment } = stateOptions;
      const deployment = await getDeploymentOrThrow(
        store,
        stateOptions.automationName,
        environment,
      );
      return await store.deleteAutomationStateValue({
        automationId: deployment.automationId,
        environment,
        key: stateOptions.key,
      });
    },

    setAutomationTimeoutGrant: async (grantOptions) => {
      const { environment } = grantOptions;
      // getDeploymentOrThrow anchors the grant to a registered automation and
      // yields a 404 for an unknown one.
      const deployment = await getDeploymentOrThrow(
        store,
        grantOptions.automationName,
        environment,
      );
      return await store.setAutomationTimeoutGrant({
        automationId: deployment.automationId,
        environment,
        maxTimeoutMs: grantOptions.maxTimeoutMs,
        note: grantOptions.note ?? null,
      });
    },

    getAutomationTimeoutGrant: async (grantOptions) => {
      const { environment } = grantOptions;
      const deployment = await getDeploymentOrThrow(
        store,
        grantOptions.automationName,
        environment,
      );
      return await store.getAutomationTimeoutGrant({
        automationId: deployment.automationId,
        environment,
      });
    },

    deleteAutomationTimeoutGrant: async (grantOptions) => {
      const { environment } = grantOptions;
      const deployment = await getDeploymentOrThrow(
        store,
        grantOptions.automationName,
        environment,
      );
      return await store.deleteAutomationTimeoutGrant({
        automationId: deployment.automationId,
        environment,
      });
    },

    listAutomationTimeoutGrants: async (environment) => {
      return await store.listAutomationTimeoutGrants(environment);
    },

    getSecret: async (name, place) => {
      return await getPlatformSecret({ name, place, store });
    },

    listAutomationDeploymentAuditEvents: async (automationName, environment, limit) => {
      return await store.listDeploymentAuditEventsByAutomationSlug(
        createDisplayName(automationName),
        environment,
        limit,
      );
    },

    listAutomationDeployments: async (automationName, environment) => {
      return await store.listDeploymentsByAutomationSlug(
        createDisplayName(automationName),
        environment,
      );
    },

    listAutomationTriggerAuditEvents: async (automationName, environment, limit) => {
      return await listStoredAutomationTriggerAuditEvents({
        automationName,
        environment,
        ...(limit !== undefined ? { limit } : {}),
        store,
      });
    },

    listNotificationDeliveries: async (deliveryOptions) => {
      return await store.listNotificationDeliveries({
        ...(deliveryOptions.automationName
          ? { automationSlug: createDisplayName(deliveryOptions.automationName) }
          : {}),
        environment: deliveryOptions.environment,
        ...(deliveryOptions.eventType ? { eventType: deliveryOptions.eventType } : {}),
        ...(deliveryOptions.limit !== undefined ? { limit: deliveryOptions.limit } : {}),
        ...(deliveryOptions.ruleOwner !== undefined
          ? { ruleOwner: deliveryOptions.ruleOwner }
          : {}),
        ...(deliveryOptions.status !== undefined ? { status: deliveryOptions.status } : {}),
        ...(deliveryOptions.createdSince !== undefined
          ? { createdSince: deliveryOptions.createdSince }
          : {}),
      });
    },

    listNotificationRules: async (environment, userId) => {
      return await store.listNotificationRules({
        environment,
        ...(userId === undefined ? {} : { userId }),
      });
    },

    getNotificationRule: async (ruleId) => await store.getNotificationRule(ruleId),

    listQueueMetricSamples: async (environment, limit) => {
      return await store.listQueueMetricSamples({
        environment,
        ...(limit !== undefined ? { limit } : {}),
      });
    },

    listSecrets: async (environment, projectIds) => {
      return await listPlatformSecrets({ environment, projectIds, store });
    },

    enqueueDueApiChecks: async (checkOptions) => {
      const due = await enqueueDueChecks({
        environment: checkOptions.environment,
        ...(checkOptions.now !== undefined ? { now: checkOptions.now } : {}),
        queue,
        store,
      });
      return due.length;
    },

    materializeDueCronRuns: async (materializeOptions) => {
      return await materializeStoredDueCronRuns({
        enqueueRun: async (input) =>
          await enqueueRunFromTrigger({
            payload: input.payload,
            queue,
            store,
            trigger: input.trigger,
            triggerType: input.triggerType,
            webhookContext: input.webhookContext ?? null,
          }),
        environment: materializeOptions.environment,
        ...(materializeOptions.limit !== undefined ? { limit: materializeOptions.limit } : {}),
        ...(materializeOptions.now !== undefined ? { now: materializeOptions.now } : {}),
        store,
      });
    },

    pauseAutomationTrigger: async (automationName, environment) => {
      return await pauseStoredAutomationTrigger({
        automationName,
        environment,
        store,
      });
    },

    reconcileQueuedRuns: async (reconcileOptions) => {
      return await reconcileQueuedRunsWithStore(store, queue, reconcileOptions);
    },

    resolveRunEvent: async (resolveOptions) => {
      const run = await getRunOrThrow(store, resolveOptions.runId);
      return await resolveWaitingEventRun({
        queue,
        run,
        stepKey: resolveOptions.stepKey,
        store,
        value: resolveOptions.value ?? null,
      });
    },

    decideApproval: async ({ runId, ...decision }) => {
      const run = await getRunOrThrow(store, runId);
      return await decideWaitingApproval({ ...decision, queue, run, store });
    },

    reassignApproval: async (reassignment) => await store.reassignApproval(reassignment),
    resolveApprovalAssignee: async (request) => await store.resolveApprovalAssignee(request),

    findWaitByLink: async (linkOptions) => {
      return await findWaitByLink({
        environment: process.env,
        kind: linkOptions.kind,
        store,
        token: linkOptions.token,
      });
    },

    resumeDueWaitingRuns: async (resumeOptions) => {
      return await resumeDueWaitingRunsWithStore({ ...resumeOptions, queue, store });
    },

    resumeAutomationTrigger: async (automationName, environment) => {
      return await resumeStoredAutomationTrigger({
        automationName,
        environment,
        store,
      });
    },

    listAutomationChainDependents: async (automationName) => {
      return await store.listAutomationChainDependents(createDisplayName(automationName));
    },
    deleteAutomation: async (deleteOptions) => {
      return await performDeleteAutomation({
        ...(options.artifactsDirectory !== undefined
          ? { artifactsDirectory: options.artifactsDirectory }
          : {}),
        automationName: deleteOptions.automationName,
        environment: deleteOptions.environment,
        processEnvironment: process.env,
        store,
      });
    },

    countProjectContents: async (projectId) => await store.countProjectContents(projectId),

    deleteProject: async (deleteInput) => {
      return await performDeleteProject({
        ...(options.artifactsDirectory !== undefined
          ? { artifactsDirectory: options.artifactsDirectory }
          : {}),
        delete: deleteInput,
        processEnvironment: process.env,
        store,
      });
    },

    rollbackDeployment: async (rollbackOptions) => {
      return await performRollback({
        ...(options.artifactsDirectory !== undefined
          ? { artifactsDirectory: options.artifactsDirectory }
          : {}),
        automationName: rollbackOptions.automationName,
        environment: rollbackOptions.environment,
        listReadinessWorkers: options.listReadinessWorkers,
        processEnvironment: process.env,
        store,
        targetDeploymentId: rollbackOptions.targetDeploymentId,
      });
    },

    runMaintenance: async (maintenanceOptions) => {
      return await options.runMaintenance(maintenanceOptions);
    },

    startManualRun: async (runOptions) => {
      return await startStoredManualRun({
        automationName: runOptions.automationName,
        correlationId: runOptions.correlationId ?? null,
        enqueueRun: async (input) =>
          await enqueueRunFromTrigger({
            correlationId: input.correlationId ?? null,
            payload: input.payload,
            queue,
            store,
            trigger: input.trigger,
            triggerType: input.triggerType,
          }),
        environment: runOptions.environment,
        payload: runOptions.payload,
        store,
      });
    },

    triggerWebhookByPath: async (triggerOptions) => {
      return await triggerStoredWebhookByPath({
        correlationId: triggerOptions.correlationId ?? null,
        enqueueRun: async (input) =>
          await enqueueRunFromTrigger({
            correlationId: input.correlationId ?? null,
            payload: input.payload,
            queue,
            store,
            trigger: input.trigger,
            triggerType: input.triggerType,
            webhookContext: input.webhookContext ?? null,
          }),
        environment: triggerOptions.environment,
        path: triggerOptions.path,
        payload: triggerOptions.payload,
        store,
        webhookContext: triggerOptions.webhookContext ?? null,
      });
    },

    updateNotificationRule: async (ruleOptions) => {
      return await store.updateNotificationRule({
        ...(ruleOptions.chatId !== undefined ? { chatId: ruleOptions.chatId.trim() } : {}),
        ...(ruleOptions.cooldownSeconds !== undefined
          ? { cooldownSeconds: normalizePositiveInteger(ruleOptions.cooldownSeconds, 900) }
          : {}),
        ...(ruleOptions.enabled !== undefined ? { enabled: ruleOptions.enabled } : {}),
        ruleId: ruleOptions.ruleId,
        ...(ruleOptions.threshold !== undefined
          ? { threshold: normalizePositiveInteger(ruleOptions.threshold, 1) }
          : {}),
        updatedAt: new Date().toISOString(),
        ...(ruleOptions.windowSeconds !== undefined
          ? { windowSeconds: normalizePositiveInteger(ruleOptions.windowSeconds, 3600) }
          : {}),
      });
    },

    upsertSecret: async (name, value, place, secretOptions) => {
      return await upsertPlatformSecret({
        ...(secretOptions?.creator !== undefined ? { creator: secretOptions.creator } : {}),
        name,
        place,
        ...(secretOptions?.replaces !== undefined ? { replaces: secretOptions.replaces } : {}),
        store,
        value,
      });
    },
  };
}
