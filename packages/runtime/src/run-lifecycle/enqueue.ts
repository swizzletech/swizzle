import { randomUUID } from "node:crypto";
import type {
  ControlPlaneStore,
  ListQueuedRunsPageInput,
  RunTriggerType,
  StoredDeployment,
  StoredRun,
} from "@swizzle/db";
import { getErrorMessage } from "../errors.js";
import {
  ensureDeploymentConnectionsPresent,
  ensureTriggerConnectionsPresent,
} from "../platform-connections.js";
import {
  ensureDeploymentSecretsPresent,
  ensureTriggerSecretsPresent,
} from "../platform-secrets.js";
import type {
  PlatformRunRecord,
  PlatformTriggerRecord,
  ReconcileQueuedRunsOptions,
  ReconcileQueuedRunsResult,
} from "../platform-types.js";
import { planRunEnqueue } from "../run-enqueue-plan.js";
import type { RunQueueProducer } from "../run-queue.js";
import { createQueueNameForProfile } from "../runtime-requirements.js";
import { getRunOrThrow } from "./records.js";

const QUEUED_RUN_PAGE_SIZE = 100;

/**
 * Enqueues every queued run whose BullMQ job is gone: runs that never had an attempt get
 * their job back, suspended segments get their resume job, and retries keep their remaining
 * delay and segment budget. PostgreSQL holds the rows, so this recovers what a Valkey
 * restart lost. The scheduler's reconcile tick calls it.
 */
export async function reconcileQueuedRunsWithStore(
  store: ControlPlaneStore,
  queue: RunQueueProducer,
  options: ReconcileQueuedRunsOptions,
): Promise<ReconcileQueuedRunsResult> {
  const requeuedRunIds: string[] = [];
  const skippedExistingJobIds: string[] = [];

  for await (const run of pageQueuedRuns(
    (input) => store.listQueuedRuns(input),
    options.environment,
  )) {
    const plan = planRunEnqueue(run, Date.now());
    if (await queue.hasJob({ jobId: plan.jobId, queueName: run.queueName })) {
      skippedExistingJobIds.push(plan.jobId);
      continue;
    }
    await enqueuePersistedRun({ queue, run, store }, plan);
    requeuedRunIds.push(run.runId);
  }

  return {
    requeuedCount: requeuedRunIds.length,
    requeuedRunIds,
    skippedExistingJobIds,
  };
}

type ListQueuedRunsPage = (input: ListQueuedRunsPageInput) => Promise<readonly StoredRun[]>;

export async function enqueueRunFromDeployment(
  input: PersistRunFromDeploymentInput & { readonly queue: RunQueueProducer },
): Promise<PlatformRunRecord> {
  const run = await persistRunFromDeployment(input);

  return await enqueuePersistedRun({
    queue: input.queue,
    run,
    store: input.store,
  });
}

export async function enqueueRunFromTrigger(
  input: PersistRunFromTriggerInput & { readonly queue: RunQueueProducer },
): Promise<PlatformRunRecord> {
  const run = await persistRunFromTrigger(input);

  return await enqueuePersistedRun({
    queue: input.queue,
    run,
    store: input.store,
  });
}

type PersistRunFromDeploymentInput = {
  readonly deployment: StoredDeployment;
  readonly invokeDepth?: number;
  readonly parentRunId?: string | null;
  readonly parentStepKey?: string | null;
  readonly payload: unknown;
  readonly runId?: string;
  readonly store: ControlPlaneStore;
  readonly triggerType: RunTriggerType;
  readonly webhookContext?: StoredRun["webhookContext"];
};

export async function persistRunFromDeployment(
  input: PersistRunFromDeploymentInput,
): Promise<PlatformRunRecord> {
  await ensureDeploymentSecretsPresent({ deployment: input.deployment, store: input.store });
  await ensureDeploymentConnectionsPresent({ deployment: input.deployment, store: input.store });
  const runId = input.runId ?? randomUUID();

  return await input.store.createRun({
    attemptsMax: input.deployment.config.runtime.retry.max_attempts,
    automationId: input.deployment.automationId,
    deploymentId: input.deployment.deploymentId,
    invokeDepth: input.invokeDepth ?? 0,
    payload: input.payload,
    parentRunId: input.parentRunId ?? null,
    parentStepKey: input.parentStepKey ?? null,
    queueJobId: runId,
    queueName: createQueueNameForProfile(input.deployment.runtimeSnapshot.profile),
    runId,
    triggerType: input.triggerType,
    versionId: input.deployment.versionId,
    webhookContext: input.webhookContext ?? null,
  });
}

type PersistRunFromTriggerInput = {
  readonly chainOriginRunId?: string | null;
  readonly chainSourceRunIds?: readonly string[];
  readonly correlationId?: string | null;
  readonly payload: unknown;
  readonly store: ControlPlaneStore;
  readonly trigger: PlatformTriggerRecord;
  readonly triggerType: RunTriggerType;
  readonly webhookContext?: StoredRun["webhookContext"];
};

export async function persistRunFromTrigger(
  input: PersistRunFromTriggerInput,
): Promise<PlatformRunRecord> {
  await ensureTriggerRunPreconditions({ store: input.store, trigger: input.trigger });
  const runId = randomUUID();

  return await input.store.createRun({
    attemptsMax: input.trigger.config.runtime.retry.max_attempts,
    automationId: input.trigger.automationId,
    chainOriginRunId: input.chainOriginRunId ?? null,
    chainSourceRunIds: input.chainSourceRunIds ?? [],
    correlationId: input.correlationId ?? null,
    deploymentId: input.trigger.deploymentId,
    payload: input.payload,
    queueJobId: runId,
    queueName: createQueueNameForProfile(input.trigger.config.runtime.profile),
    runId,
    triggerType: input.triggerType,
    versionId: input.trigger.versionId,
    webhookContext: input.webhookContext ?? null,
  });
}

export async function persistChainJoinRunFromTrigger(input: {
  readonly originRunId: string;
  readonly payload: unknown;
  readonly sourceRunIds: readonly string[];
  readonly store: ControlPlaneStore;
  readonly trigger: PlatformTriggerRecord;
}): Promise<PlatformRunRecord | null> {
  await ensureTriggerRunPreconditions({
    store: input.store,
    trigger: input.trigger,
  });

  const runId = randomUUID();
  const run = await input.store.createChainJoinRun({
    attemptsMax: input.trigger.config.runtime.retry.max_attempts,
    automationId: input.trigger.automationId,
    deploymentId: input.trigger.deploymentId,
    originRunId: input.originRunId,
    payload: input.payload,
    queueJobId: runId,
    queueName: createQueueNameForProfile(input.trigger.config.runtime.profile),
    runId,
    sourceRunIds: input.sourceRunIds,
    triggerId: input.trigger.triggerId,
    triggerType: "chain",
    versionId: input.trigger.versionId,
  });

  return run;
}

async function ensureTriggerRunPreconditions(input: {
  readonly store: ControlPlaneStore;
  readonly trigger: PlatformTriggerRecord;
}): Promise<void> {
  await ensureTriggerSecretsPresent({
    store: input.store,
    trigger: input.trigger,
  });

  await ensureTriggerConnectionsPresent({
    store: input.store,
    trigger: input.trigger,
  });
}

export async function enqueuePersistedRun(
  input: {
    readonly queue: RunQueueProducer;
    readonly run: PlatformRunRecord;
    readonly store: ControlPlaneStore;
  },
  plan = planRunEnqueue(input.run, Date.now()),
): Promise<PlatformRunRecord> {
  try {
    await input.queue.enqueue({
      ...plan,
      queueName: input.run.queueName,
      runId: input.run.runId,
    });
  } catch (error) {
    await input.store.recordRunEnqueueError(input.run.runId, getErrorMessage(error));
  }

  return await getRunOrThrow(input.store, input.run.runId);
}

async function* pageQueuedRuns(
  list: ListQueuedRunsPage,
  environment: string | undefined,
): AsyncGenerator<StoredRun> {
  let afterRunId: string | undefined;
  for (;;) {
    const page = await list({
      ...(afterRunId !== undefined ? { afterRunId } : {}),
      ...(environment !== undefined ? { environment } : {}),
      limit: QUEUED_RUN_PAGE_SIZE,
    });
    yield* page;
    const last = page.at(-1);
    if (page.length < QUEUED_RUN_PAGE_SIZE || last === undefined) return;
    afterRunId = last.runId;
  }
}
