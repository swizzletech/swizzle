import {
  createLeaderLock,
  createPlatformServices,
  type LeaderLock,
  type PlatformRunRecord,
  type PlatformServices,
} from "@swizzle/runtime/platform";

interface SchedulerLogger {
  child?(bindings: Record<string, unknown>): SchedulerLogger;
  debug(...args: readonly unknown[]): void;
  error(...args: readonly unknown[]): void;
  info(...args: readonly unknown[]): void;
  warn(...args: readonly unknown[]): void;
}

export interface CreateSchedulerServiceOptions {
  readonly batchSize?: number;
  readonly enableLeaderLock?: boolean;
  /** The one environment whose cron triggers, waiting runs and maintenance this scheduler serves. */
  readonly environmentName: string;
  readonly instanceId?: string;
  readonly intervalMs?: number;
  readonly leaderKey?: string;
  readonly leaderTtlMs?: number;
  readonly logger?: SchedulerLogger;
  readonly maintenanceIntervalMs?: number;
  readonly platform?: PlatformServices;
  readonly reconcileIntervalMs?: number;
  readonly resumeWaitingIntervalMs?: number;
  readonly valkeyUrl?: string;
}

export interface SchedulerService {
  close(): Promise<void>;
  pollOnce(now?: Date): Promise<readonly PlatformRunRecord[]>;
  reconcileRunsOnce(): Promise<void>;
  resumeWaitingRunsOnce(now?: Date): Promise<number>;
  runMaintenanceOnce(now?: Date): Promise<void>;
  start(): void;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_RESUME_WAITING_INTERVAL_MS = 5_000;

export async function createSchedulerService(
  options: CreateSchedulerServiceOptions,
): Promise<SchedulerService> {
  const environment = options.environmentName;
  const platform = options.platform ?? (await createPlatformServices());
  const ownPlatform = options.platform === undefined;
  let intervalHandle: NodeJS.Timeout | null = null;
  let maintenanceHandle: NodeJS.Timeout | null = null;
  let reconcileHandle: NodeJS.Timeout | null = null;
  let resumeWaitingHandle: NodeJS.Timeout | null = null;
  let polling = false;
  let maintaining = false;
  let reconciling = false;
  let resumingWaitingRuns = false;

  const leaderLockEnabled = options.enableLeaderLock ?? false;
  const leaderLock: LeaderLock | null = leaderLockEnabled
    ? createLeaderLock({
        instanceId: options.instanceId ?? `scheduler-${process.pid}`,
        key: options.leaderKey ?? "swizzle:scheduler:leader",
        ...(options.logger ? { logger: options.logger } : {}),
        // A new leader reconciles at once instead of waiting for its next tick: leadership
        // changes on boot and after a Valkey restart, which is when queue jobs go missing.
        onLeaderAcquired: () => {
          void reconcileRunsOnce().catch((error) => {
            options.logger?.error(error, "Run reconciliation failed.");
          });
        },
        ttlMs: options.leaderTtlMs ?? Number(process.env.SWIZZLE_LEADER_TTL_MS ?? 30_000),
        ...(options.valkeyUrl ? { valkeyUrl: options.valkeyUrl } : {}),
      })
    : null;

  const pollOnce = async (now = new Date()): Promise<readonly PlatformRunRecord[]> => {
    if (polling) {
      options.logger?.debug("Skipping scheduler poll because the previous poll is still running.");
      return [];
    }

    if (leaderLock && !leaderLock.isLeader()) {
      options.logger?.debug("Skipping scheduler poll because this instance is not the leader.");
      return [];
    }

    polling = true;
    try {
      const runs = await platform.materializeDueCronRuns({
        environment,
        limit: options.batchSize ?? DEFAULT_BATCH_SIZE,
        now,
      });

      if (runs.length > 0) {
        options.logger?.info(
          {
            runIds: runs.map((run) => run.runId),
            runs: runs.length,
          },
          "Materialized due cron runs.",
        );
      } else {
        options.logger?.debug("No due cron runs found.");
      }

      // A failing check query must not hold up cron runs; the next tick tries again.
      try {
        const checks = await platform.enqueueDueApiChecks({ environment, now });
        if (checks > 0) options.logger?.info({ checks }, "Enqueued due API checks.");
      } catch (error) {
        options.logger?.error(error, "Enqueueing due API checks failed.");
      }

      return runs;
    } finally {
      polling = false;
    }
  };

  // Reconstructs queued jobs lost with Valkey. Execution leases are reconciled by the API.
  const reconcileRunsOnce = async (): Promise<void> => {
    if (reconciling) {
      options.logger?.debug(
        "Skipping run reconciliation because the previous tick is still running.",
      );
      return;
    }

    if (leaderLock && !leaderLock.isLeader()) {
      options.logger?.debug("Skipping run reconciliation because this instance is not the leader.");
      return;
    }

    reconciling = true;
    try {
      const queued = await platform.reconcileQueuedRuns({ environment });
      if (queued.requeuedCount > 0) {
        options.logger?.warn(
          {
            event: "run_requeued_orphaned",
            requeuedCount: queued.requeuedCount,
            runIds: queued.requeuedRunIds,
          },
          "Requeued queued runs whose queue job was gone.",
        );
      }
    } finally {
      reconciling = false;
    }
  };

  const runMaintenanceOnce = async (now = new Date()): Promise<void> => {
    if (maintaining) {
      options.logger?.debug(
        "Skipping scheduler maintenance because the previous maintenance run is still active.",
      );
      return;
    }

    if (leaderLock && !leaderLock.isLeader()) {
      options.logger?.debug("Skipping maintenance because this instance is not the leader.");
      return;
    }

    maintaining = true;
    try {
      const result = await platform.runMaintenance({ environment, now });
      options.logger?.debug(
        {
          maintenanceRunId: result.latestRun.maintenanceRunId,
          artifactSweepDeleted: result.artifactSweep.deleted,
          artifactSweepErrors: result.artifactSweep.errors.length,
          artifactSweepSkipped: result.artifactSweep.skipped,
          queueWaiting: result.queueSample.counts.waiting,
        },
        "Scheduler maintenance completed.",
      );
    } finally {
      maintaining = false;
    }
  };

  const resumeWaitingRunsOnce = async (now = new Date()): Promise<number> => {
    if (resumingWaitingRuns) {
      options.logger?.debug(
        "Skipping waiting-run resume because the previous tick is still running.",
      );
      return 0;
    }

    if (leaderLock && !leaderLock.isLeader()) {
      options.logger?.debug("Skipping waiting-run resume because this instance is not the leader.");
      return 0;
    }

    resumingWaitingRuns = true;
    try {
      const result = await platform.resumeDueWaitingRuns({
        environment,
        limit: options.batchSize ?? DEFAULT_BATCH_SIZE,
        now,
      });
      if (result.resumedCount > 0) {
        options.logger?.info(
          {
            event: "waiting_runs_resumed",
            resumedCount: result.resumedCount,
            runIds: result.resumedRunIds,
          },
          "Resumed due waiting runs.",
        );
      } else {
        options.logger?.debug("No waiting runs due for resume.");
      }
      return result.resumedCount;
    } finally {
      resumingWaitingRuns = false;
    }
  };

  return {
    close: async () => {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      if (maintenanceHandle) {
        clearInterval(maintenanceHandle);
        maintenanceHandle = null;
      }
      if (reconcileHandle) {
        clearInterval(reconcileHandle);
        reconcileHandle = null;
      }
      if (resumeWaitingHandle) {
        clearInterval(resumeWaitingHandle);
        resumeWaitingHandle = null;
      }

      if (leaderLock) {
        await leaderLock.close();
      }

      if (ownPlatform) {
        await platform.close();
      }
    },

    pollOnce,
    reconcileRunsOnce,
    resumeWaitingRunsOnce,
    runMaintenanceOnce,

    start: () => {
      if (leaderLock) {
        void leaderLock.start().catch((error) => {
          options.logger?.error(error, "Leader lock start failed.");
        });
      }

      if (!intervalHandle) {
        intervalHandle = setInterval(() => {
          void pollOnce().catch((error) => {
            options.logger?.error(error, "Scheduler poll failed.");
          });
        }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
      }

      if (!maintenanceHandle) {
        maintenanceHandle = setInterval(() => {
          void runMaintenanceOnce().catch((error) => {
            options.logger?.error(error, "Scheduler maintenance failed.");
          });
        }, options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS);
      }

      if (!reconcileHandle) {
        reconcileHandle = setInterval(() => {
          void reconcileRunsOnce().catch((error) => {
            options.logger?.error(error, "Run reconciliation failed.");
          });
        }, options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
      }

      if (!resumeWaitingHandle) {
        resumeWaitingHandle = setInterval(() => {
          void resumeWaitingRunsOnce().catch((error) => {
            options.logger?.error(error, "Waiting-run resume failed.");
          });
        }, options.resumeWaitingIntervalMs ?? DEFAULT_RESUME_WAITING_INTERVAL_MS);
      }
    },
  };
}
