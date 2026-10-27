import { setTimeout as delay } from "node:timers/promises";
import { context as otContext, propagation } from "@opentelemetry/api";
import type {
  ControlPlaneStore,
  DispatchStore,
  ExecutionLease,
  LeaseRef,
  PlacementTarget,
  RegisteredWorker,
  WorkerIdentity,
  WorkerRegistry,
} from "@swizzle/db";
import { workerFit, workerReaches } from "@swizzle/db";
import { DelayedError, type Job, Worker } from "bullmq";
import { readDeployedSource } from "./deployed-execution.js";
import { AutomationRuntimeError } from "./errors.js";
import { createExecutionService, type ExecutionService } from "./execution-service.js";
import { createRunLogPublisher } from "./log-stream.js";
import { deliverPendingNotification } from "./notifications.js";
import type { PlatformLogger } from "./platform-types.js";
import { openControlPlaneStore, openRunImageRetentionStore } from "./postgres-stores.js";
import { checkAndRecordRunRateLimits } from "./rate-limit-enforcement.js";
import { createRateLimiter } from "./rate-limiter.js";
import {
  failPlacement,
  loseRunExecution,
  processRunTerminalEffects,
  reconcileQueuedRunsWithStore,
} from "./run-lifecycle.js";
import {
  createBullMqConnection,
  createRunQueueProducer,
  DEFAULT_VALKEY_URL,
  type QueueJobData,
} from "./run-queue.js";
import { createQueueNameForProfile } from "./runtime-requirements.js";
import type { ExecutionAssignment, PreparationSnapshot } from "./worker-wire.js";

/**
 * A queued job waiting for a worker that may take it. The job ends once a worker claims it:
 * from then on the lease in PostgreSQL owns the execution.
 */
interface Offer {
  readonly id: string;
  readonly data: QueueJobData;
  readonly target: PlacementTarget;
  readonly rateLimits: Record<string, string>;
  claimers: number;
  /** True once a worker claimed the offer, false once it was withdrawn. */
  readonly claimed: Promise<boolean>;
  readonly settle: (claimed: boolean) => void;
}
/** The worker routes' server side. Requests of an accepted execution go to the execution service. */
export interface ServerDispatch extends Omit<ExecutionService, "prepare"> {
  preparations(
    identity: RegisteredWorker,
    knownIds: readonly string[],
  ): Promise<PreparationSnapshot>;
  recordRunImage(identity: RegisteredWorker, deploymentId: string, tag: string): Promise<void>;
  /** The run image tags this worker's next prune pass keeps. */
  runImageKeep(identity: RegisteredWorker): Promise<readonly string[]>;
  pull(identity: RegisteredWorker, signal?: AbortSignal): Promise<ExecutionAssignment | null>;
  renew(identity: WorkerIdentity, lease: LeaseRef): Promise<ExecutionLease>;
  /** Stops admission and unblocks requests before listeners drain. */
  stop(): void;
  close(): Promise<void>;
}

/**
 * BullMQ offers, claims and the reconcile loop live here. Executors see only an assignment and
 * scoped replies; a claimed execution belongs to its lease in PostgreSQL, not to this process.
 */
export async function createServerDispatch(options: {
  readonly registry: WorkerRegistry;
  readonly dispatch: DispatchStore;
  readonly store?: ControlPlaneStore;
  readonly valkeyUrl?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly logger?: PlatformLogger;
}): Promise<ServerDispatch> {
  const store = options.store ?? (await openControlPlaneStore());
  const images = await openRunImageRetentionStore();
  const environment = options.environment ?? process.env;
  const valkeyUrl = options.valkeyUrl ?? DEFAULT_VALKEY_URL;
  const queue = createRunQueueProducer(valkeyUrl);
  const limiter = createRateLimiter(valkeyUrl);
  const logs = createRunLogPublisher(valkeyUrl);
  const executions = createExecutionService({
    dispatch: options.dispatch,
    environment,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    publish: (event) => logs.publish(event),
    store,
  });
  const offers = new Map<string, Offer>();
  const consumers = new Map<string, Worker<QueueJobData>>();
  let closing = false;
  const handleJob = async (job: Job<QueueJobData>, profile: string, token?: string) => {
    const data = job.data;
    const run = data.kind === "run" ? await store.getRun(data.runId) : null;
    if (data.kind === "run" && run?.status !== "queued") return null;
    const check = data.kind === "check" ? await store.getAutomationCheck(data.checkId) : null;
    const deployment = check === null ? null : await store.getDeploymentById(check.deploymentId);
    if (data.kind === "check" && (check?.nextCheckAt !== data.dueAt || deployment === null))
      return null;
    const target = run ?? deployment;
    if (target === null || target.config.runtime.profile !== profile) return null;
    const id = job.id;
    if (id === undefined) throw new Error("Queue job has no id.");
    let settle: (claimed: boolean) => void = () => {};
    const claimed = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const offer: Offer = {
      id,
      data,
      target: {
        projectId: target.projectId,
        environment: target.environment,
        profile,
        services: target.config.runtime.permissions.services,
      },
      rateLimits: target.config.runtime.rate_limits,
      claimers: 0,
      claimed,
      settle,
    };
    offers.get(id)?.settle(false);
    offers.set(id, offer);
    // Offers without a matching claimant yield their BullMQ slot to other grants.
    const offerTimer = setInterval(() => {
      if (offer.claimers === 0 && offers.get(id) === offer) {
        offers.delete(id);
        offer.settle(false);
      }
    }, 250);
    const taken = await claimed.finally(() => clearInterval(offerTimer));
    if (offers.get(id) === offer) offers.delete(id);
    if (taken || closing) return null;
    await job.moveToDelayed(Date.now() + 1000, token);
    throw new DelayedError();
  };
  let notifying: Promise<void> | null = null;
  const startNotifications = () => {
    if (notifying !== null || closing) return;
    notifying = options.dispatch
      .drainNotifications(async (delivery, store) => {
        await deliverPendingNotification(delivery, store);
      })
      .catch((error) => options.logger?.error(error, "Notification delivery failed."))
      .finally(() => {
        notifying = null;
      });
  };
  let ticking: Promise<void> | null = null;
  const tick = async () => {
    await options.dispatch.reclaim((lost, store) => loseRunExecution({ ...lost, store }));
    await options.dispatch.expirePlacements((expired, store) =>
      failPlacement({ ...expired, store }),
    );
    await options.dispatch.drainTerminals((run, store) =>
      processRunTerminalEffects({ run, store }),
    );
    startNotifications();
    // PostgreSQL reconstructs jobs lost with Valkey or an interrupted enqueue, and enqueues a
    // retry once its execution ended.
    await reconcileQueuedRunsWithStore(store, queue, {});
    for (const worker of await options.registry.list()) {
      if (worker.state === "revoked") continue;
      for (const profile of worker.profiles) {
        if (consumers.has(profile)) continue;
        const consumer = new Worker<QueueJobData>(
          createQueueNameForProfile(profile),
          (job, token) => handleJob(job, profile, token),
          {
            connection: createBullMqConnection(valkeyUrl, true),
            concurrency: 64,
          },
        );
        consumer.on("error", (error) =>
          options.logger?.error(error, "Server dispatch queue failed."),
        );
        consumer.on("failed", (_job, error) =>
          options.logger?.warn({ error }, "Server dispatch job failed."),
        );
        consumers.set(profile, consumer);
      }
    }
    for (const offer of offers.values()) {
      if (offer.data.kind === "run" && (await store.getRun(offer.data.runId))?.status !== "queued")
        offer.settle(false);
    }
  };
  const startTick = () => {
    if (ticking !== null || closing) return;
    ticking = tick()
      .catch((error) => options.logger?.error(error, "Dispatch reconciliation failed."))
      .finally(() => {
        ticking = null;
      });
  };
  await tick();
  const timer = setInterval(startTick, 1_000);
  const stop = () => {
    closing = true;
    clearInterval(timer);
    for (const offer of offers.values()) offer.settle(false);
  };
  return {
    async preparations(identity, knownIds) {
      const active = (await store.listActiveDeployments()).filter(
        (deployment) =>
          identity.profiles.includes(deployment.config.runtime.profile) &&
          workerReaches(identity.environments, deployment),
      );
      const deployments = [];
      const known = new Set(knownIds);
      for (const deployment of active
        .filter((deployment) => !known.has(deployment.deploymentId))
        .slice(0, 1)) {
        const target = {
          projectId: deployment.projectId,
          environment: deployment.environment,
          profile: deployment.config.runtime.profile,
        };
        await options.registry.session(identity, target);
        deployments.push({
          deploymentId: deployment.deploymentId,
          automationName: deployment.automationName,
          deployedAt: deployment.deployedAt,
          files: await readDeployedSource(deployment, environment),
        });
        await options.registry.session(identity, target);
      }
      return { activeIds: active.map((deployment) => deployment.deploymentId), deployments };
    },
    async recordRunImage(identity, deploymentId, tag) {
      const deployment = await store.getDeploymentById(deploymentId);
      if (deployment === null)
        throw new AutomationRuntimeError("DEPLOYMENT_NOT_FOUND", "Deployment not found.");
      await options.registry.session(identity, {
        projectId: deployment.projectId,
        environment: deployment.environment,
        profile: deployment.config.runtime.profile,
      });
      await images.record({
        deploymentId,
        workerId: identity.id,
        environment: deployment.environment,
        tag,
      });
    },
    runImageKeep: (identity) => images.keep(identity.id),
    async pull(identity, signal) {
      if (closing || identity.draining) return null;
      const worker = await options.registry.heartbeat(identity);
      const deadline = Date.now() + 15_000;
      while (!closing && !signal?.aborted && Date.now() < deadline) {
        for (const offer of offers.values()) {
          // Slots free up during the long poll; the claim counts them again under the worker lock.
          const fit = workerFit(worker, offer.target);
          if (fit !== "ready" && fit !== "busy") continue;
          // Rate admission precedes claiming: a blocked run remains queued without spending an attempt.
          const admit = async () =>
            (
              await checkAndRecordRunRateLimits({
                rateLimiter: limiter,
                rateLimits: offer.rateLimits,
              })
            ).allowed;
          offer.claimers++;
          let lease: ExecutionLease | null;
          try {
            lease =
              offer.data.kind === "run"
                ? await options.dispatch.claim(identity, offer.data.runId, admit)
                : await options.dispatch.claimCheck(
                    identity,
                    offer.data.checkId,
                    offer.data.dueAt,
                    admit,
                  );
          } finally {
            offer.claimers--;
          }
          if (lease === null) continue;
          offers.delete(offer.id);
          offer.settle(true);
          const claimed = lease;
          return await otContext.with(
            propagation.extract(
              otContext.active(),
              offer.data.kind === "run" ? (offer.data.traceContext ?? {}) : {},
            ),
            () => executions.prepare(identity, claimed, signal),
          );
        }
        await delay(100);
      }
      return null;
    },
    renew: (identity, lease) => options.dispatch.renew(identity, lease),
    source: (identity, lease) => executions.source(identity, lease),
    start: (identity, lease) => executions.start(identity, lease),
    ready: (identity, lease) => executions.ready(identity, lease),
    output: (identity, lease, sequence, stream, chunk) =>
      executions.output(identity, lease, sequence, stream, chunk),
    complete: (identity, lease, report) => executions.complete(identity, lease, report),
    stop,
    async close() {
      stop();
      await ticking;
      await notifying;
      await Promise.all([...consumers.values()].map((worker) => worker.close()));
      await Promise.all([queue.close(), limiter.close(), logs.close(), images.close()]);
      if (options.store === undefined) await store.close();
      await options.dispatch.close();
    },
  };
}
