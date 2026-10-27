import { AUTOMATION_RUNTIME_PROFILE_DEFAULT } from "@swizzle/config";
import type {
  CleanupMaintenanceResult,
  ControlPlaneStore,
  CreateQueueMetricSampleInput,
  ExpireRunsResult,
  StoredDeployment,
  StoredMaintenanceRun,
} from "@swizzle/db";
import { Queue } from "bullmq";

import { createQueueNameForProfile } from "./runtime-requirements.js";
import { createArtifactStorageForReference, getArtifactTreeKey } from "./storage.js";

const DEFAULT_QUEUE_NAME = "platform-runs";
const DEFAULT_VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const DEFAULT_NOTIFICATION_DELIVERY_RETENTION_DAYS = 30;
const DEFAULT_QUEUE_METRIC_RETENTION_DAYS = 14;
const DEFAULT_HEARTBEAT_RETENTION_HOURS = 6;
const DEFAULT_QUEUE_FAILED_RETENTION_HOURS = 24;
const DEFAULT_RUN_RETENTION_DAYS = 30;
const DEFAULT_ARTIFACT_RETENTION_DEPLOYMENTS = 5;

interface QueueCounts {
  readonly active: number;
  readonly completed: number;
  readonly delayed: number;
  readonly failed: number;
  readonly waiting: number;
}

interface QueueMetricsReader {
  close(): Promise<void>;
  cleanFailedOlderThan(gracePeriodMs: number): Promise<number>;
  getCounts(): Promise<QueueCounts>;
}

export interface MaintenanceRetentionPolicy {
  readonly artifactRetentionDeployments: number | null;
  readonly heartbeatRetentionHours: number;
  readonly notificationDeliveryRetentionDays: number;
  readonly queueFailedRetentionHours: number;
  readonly queueMetricRetentionDays: number;
  /** Days a finished run is kept after it finished; null keeps runs forever. */
  readonly runRetentionDays: number | null;
}

export interface RunMaintenanceCycleInput {
  readonly environment: string;
  readonly now?: Date;
  readonly queueCounts?: QueueCounts;
  readonly queueName?: string;
  readonly retention?: Partial<MaintenanceRetentionPolicy>;
  readonly store: ControlPlaneStore;
  readonly valkeyUrl?: string;
}

export interface MaintenanceCycleResult {
  readonly artifactSweep: ArtifactSweepResult;
  readonly cleanup: CleanupMaintenanceResult;
  readonly latestRun: StoredMaintenanceRun;
  readonly runExpiry: ExpireRunsResult;
  readonly queueSample: CreateQueueMetricSampleInput;
}

interface ArtifactSweepResult {
  readonly deleted: number;
  readonly errors: readonly { readonly deploymentId: string; readonly message: string }[];
  readonly kept: number;
  readonly skipped: boolean;
}

export function resolveMaintenanceRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): MaintenanceRetentionPolicy {
  return {
    artifactRetentionDeployments: parseNullableNonNegativeInt(
      env.SWIZZLE_ARTIFACT_RETENTION_DEPLOYMENTS,
      DEFAULT_ARTIFACT_RETENTION_DEPLOYMENTS,
    ),
    heartbeatRetentionHours: parsePositiveInt(
      env.SWIZZLE_HEARTBEAT_RETENTION_HOURS,
      DEFAULT_HEARTBEAT_RETENTION_HOURS,
    ),
    notificationDeliveryRetentionDays: parsePositiveInt(
      env.SWIZZLE_NOTIFICATION_DELIVERY_RETENTION_DAYS,
      DEFAULT_NOTIFICATION_DELIVERY_RETENTION_DAYS,
    ),
    queueFailedRetentionHours: parsePositiveInt(
      env.SWIZZLE_QUEUE_FAILED_RETENTION_HOURS,
      DEFAULT_QUEUE_FAILED_RETENTION_HOURS,
    ),
    queueMetricRetentionDays: parsePositiveInt(
      env.SWIZZLE_QUEUE_METRIC_RETENTION_DAYS,
      DEFAULT_QUEUE_METRIC_RETENTION_DAYS,
    ),
    runRetentionDays: parseNullablePositiveInt(
      env.SWIZZLE_RUN_RETENTION_DAYS,
      DEFAULT_RUN_RETENTION_DAYS,
    ),
  };
}

export async function runMaintenanceCycle(
  input: RunMaintenanceCycleInput,
): Promise<MaintenanceCycleResult> {
  const startedAt = input.now ?? new Date();
  const { environment } = input;
  const retention = {
    ...resolveMaintenanceRetentionPolicy(),
    ...(input.retention ?? {}),
  } satisfies MaintenanceRetentionPolicy;
  let queueReaders: QueueMetricsReader[] = [];

  try {
    const deployments = await input.store.listDeploymentsForArtifactRetention(environment);
    queueReaders =
      input.queueCounts === undefined
        ? resolveMaintenanceQueueNames(deployments, input.queueName).map((queueName) =>
            createQueueMetricsReader({
              queueName,
              valkeyUrl: input.valkeyUrl ?? DEFAULT_VALKEY_URL,
            }),
          )
        : [];

    // Prune failed BullMQ jobs older than the retention window BEFORE counting.
    // Without this, a single failure keeps queue.counts.failed > 0 forever,
    // which pins the dashboard to `state: degraded — queue-pressure` regardless
    // of recent activity. Matches how heartbeats and notification deliveries
    // decay — operator-relevant signal is "recent failures", not "ever-failed".
    if (queueReaders.length > 0 && input.queueCounts === undefined) {
      await Promise.all(
        queueReaders.map(
          async (queueReader) =>
            await queueReader.cleanFailedOlderThan(
              retention.queueFailedRetentionHours * 60 * 60 * 1000,
            ),
        ),
      );
    }

    const queueCounts =
      input.queueCounts ??
      aggregateQueueCounts(await Promise.all(queueReaders.map((reader) => reader.getCounts())));
    const queueSampleInput: CreateQueueMetricSampleInput = {
      counts: queueCounts,
      environment,
      observedAt: startedAt.toISOString(),
      queueName: input.queueName ?? DEFAULT_QUEUE_NAME,
    };
    await input.store.createQueueMetricSample(queueSampleInput);

    const cleanup = await input.store.cleanupMaintenanceData({
      deliveryCutoff: new Date(
        startedAt.getTime() - retention.notificationDeliveryRetentionDays * 24 * 60 * 60 * 1000,
      ).toISOString(),
      environment,
      heartbeatCutoff: new Date(
        startedAt.getTime() - retention.heartbeatRetentionHours * 60 * 60 * 1000,
      ).toISOString(),
      metricsCutoff: new Date(
        startedAt.getTime() - retention.queueMetricRetentionDays * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });

    // ADR 0015: a finished run expires as a whole; queued, running and waiting runs never do.
    const runExpiry =
      retention.runRetentionDays !== null
        ? await input.store.expireRuns({
            cutoff: new Date(
              startedAt.getTime() - retention.runRetentionDays * 24 * 60 * 60 * 1000,
            ).toISOString(),
          })
        : { runsDeleted: 0 };

    const artifactSweep = await sweepDeploymentArtifacts({
      deployments,
      environment: process.env,
      keepLastDeployments: retention.artifactRetentionDeployments,
    });

    const finishedAt = new Date().toISOString();
    const latestRun = await input.store.createMaintenanceRun({
      environment,
      finishedAt,
      startedAt: startedAt.toISOString(),
      status: "succeeded",
      summary: {
        cleanup,
        artifactSweep,
        queue: queueSampleInput,
        retention,
        runExpiry,
      },
    });

    return {
      cleanup,
      artifactSweep,
      latestRun,
      queueSample: queueSampleInput,
      runExpiry,
    };
  } catch (error) {
    await input.store.createMaintenanceRun({
      environment,
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      status: "failed",
      summary: {
        retention,
      },
    });
    throw error;
  } finally {
    await Promise.all(queueReaders.map(async (queueReader) => await queueReader.close()));
  }
}

export function resolveMaintenanceQueueNames(
  deployments: readonly { readonly runtimeSnapshot: { readonly profile: string } }[],
  queueName?: string,
): readonly string[] {
  if (queueName !== undefined) {
    return [queueName];
  }

  return [
    ...new Set([
      createQueueNameForProfile(AUTOMATION_RUNTIME_PROFILE_DEFAULT),
      ...deployments.map((deployment) =>
        createQueueNameForProfile(deployment.runtimeSnapshot.profile),
      ),
    ]),
  ];
}

function aggregateQueueCounts(counts: readonly QueueCounts[]): QueueCounts {
  return counts.reduce<QueueCounts>(
    (total, current) => ({
      active: total.active + current.active,
      completed: total.completed + current.completed,
      delayed: total.delayed + current.delayed,
      failed: total.failed + current.failed,
      waiting: total.waiting + current.waiting,
    }),
    {
      active: 0,
      completed: 0,
      delayed: 0,
      failed: 0,
      waiting: 0,
    },
  );
}

async function sweepDeploymentArtifacts(input: {
  readonly deployments: readonly StoredDeployment[];
  readonly environment: NodeJS.ProcessEnv;
  readonly keepLastDeployments: number | null;
}): Promise<ArtifactSweepResult> {
  if (input.keepLastDeployments === null) {
    return { deleted: 0, errors: [], kept: input.deployments.length, skipped: true };
  }

  const byAutomation = new Map<string, StoredDeployment[]>();
  for (const deployment of input.deployments) {
    const entries = byAutomation.get(deployment.automationId) ?? [];
    entries.push(deployment);
    byAutomation.set(deployment.automationId, entries);
  }

  const retained: StoredDeployment[] = [];
  const expired: StoredDeployment[] = [];
  for (const deployments of byAutomation.values()) {
    const sorted = [...deployments].sort((left, right) => {
      const deployedAtOrder = right.deployedAt.localeCompare(left.deployedAt);
      return deployedAtOrder === 0
        ? right.deploymentId.localeCompare(left.deploymentId)
        : deployedAtOrder;
    });
    for (const [index, deployment] of sorted.entries()) {
      const keep = deployment.status === "active" || index < input.keepLastDeployments;
      (keep ? retained : expired).push(deployment);
    }
  }

  // A rollback deployment runs from its target's tree, so retention protects trees, not ids.
  const retainedTrees = new Set(retained.map(getArtifactTreeKey));
  const deleteCandidates = expired.filter(
    (deployment) => !retainedTrees.has(getArtifactTreeKey(deployment)),
  );
  const kept = input.deployments.length - deleteCandidates.length;

  const errors: { deploymentId: string; message: string }[] = [];
  let deleted = 0;
  for (const deployment of deleteCandidates) {
    const storage = createArtifactStorageForReference(deployment, {
      environment: input.environment,
    });
    try {
      await storage.deleteDeploymentArtifacts(deployment);
      deleted += 1;
    } catch (error) {
      errors.push({
        deploymentId: deployment.deploymentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { deleted, errors, kept, skipped: false };
}

function createQueueMetricsReader(options: {
  readonly queueName?: string;
  readonly valkeyUrl?: string;
}): QueueMetricsReader {
  const queue = new Queue(options.queueName ?? DEFAULT_QUEUE_NAME, {
    connection: createBullMqConnection(options.valkeyUrl ?? DEFAULT_VALKEY_URL),
  });

  return {
    async close() {
      await queue.close();
    },

    async cleanFailedOlderThan(gracePeriodMs: number) {
      // BullMQ's clean() returns the list of removed job ids. A very large
      // limit is effectively "clean all"; we cap at 10_000 to bound one tick.
      const removed = await queue.clean(gracePeriodMs, 10_000, "failed");
      return Array.isArray(removed) ? removed.length : 0;
    },

    async getCounts() {
      const counts = await queue.getJobCounts(
        "active",
        "completed",
        "delayed",
        "failed",
        "waiting",
      );

      return {
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        waiting: counts.waiting ?? 0,
      } satisfies QueueCounts;
    },
  };
}

function createBullMqConnection(valkeyUrl: string) {
  const url = new URL(valkeyUrl);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;

  return {
    ...(database === undefined || Number.isNaN(database) ? {} : { db: database }),
    host: url.hostname,
    ...(url.password ? { password: url.password } : {}),
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: url.username } : {}),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNullablePositiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "off") {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNullableNonNegativeInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "off") {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
