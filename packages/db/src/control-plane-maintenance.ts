import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { mapMaintenanceRunRow, mapQueueMetricSampleRow } from "./control-plane-read-models.js";
import type {
  CleanupMaintenanceInput,
  CleanupMaintenanceResult,
  CreateMaintenanceRunInput,
  CreateQueueMetricSampleInput,
  ExpireRunsInput,
  ExpireRunsResult,
  ListQueueMetricSamplesQuery,
  StoredMaintenanceRun,
  StoredQueueMetricSample,
} from "./control-plane-types.js";
import { FINISHED_RUN_STATUSES } from "./run-status.js";
import {
  maintenanceRuns,
  notificationDeliveries,
  queueMetricSamples,
  runs,
  serviceHeartbeats,
} from "./schema.js";

export async function cleanupMaintenanceData(
  client: DatabaseClient,
  input: CleanupMaintenanceInput,
): Promise<CleanupMaintenanceResult> {
  const heartbeatRows = await client.db
    .select({ id: serviceHeartbeats.id })
    .from(serviceHeartbeats)
    .where(
      and(
        eq(serviceHeartbeats.environment, input.environment),
        lte(serviceHeartbeats.observedAt, new Date(input.heartbeatCutoff)),
      ),
    );
  const deliveryRows = await client.db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.environment, input.environment),
        lte(notificationDeliveries.createdAt, new Date(input.deliveryCutoff)),
      ),
    );
  const metricRows = await client.db
    .select({ id: queueMetricSamples.id })
    .from(queueMetricSamples)
    .where(
      and(
        eq(queueMetricSamples.environment, input.environment),
        lte(queueMetricSamples.observedAt, new Date(input.metricsCutoff)),
      ),
    );

  if (heartbeatRows.length > 0) {
    await client.db.delete(serviceHeartbeats).where(
      inArray(
        serviceHeartbeats.id,
        heartbeatRows.map((row) => row.id),
      ),
    );
  }

  if (deliveryRows.length > 0) {
    await client.db.delete(notificationDeliveries).where(
      inArray(
        notificationDeliveries.id,
        deliveryRows.map((row) => row.id),
      ),
    );
  }

  if (metricRows.length > 0) {
    await client.db.delete(queueMetricSamples).where(
      inArray(
        queueMetricSamples.id,
        metricRows.map((row) => row.id),
      ),
    );
  }

  return {
    deletedDeliveries: deliveryRows.length,
    deletedHeartbeats: heartbeatRows.length,
    deletedMetricSamples: metricRows.length,
  } satisfies CleanupMaintenanceResult;
}

export async function createMaintenanceRun(
  client: DatabaseClient,
  input: CreateMaintenanceRunInput,
): Promise<StoredMaintenanceRun> {
  const [row] = await client.db
    .insert(maintenanceRuns)
    .values({
      environment: input.environment,
      errorMessage: input.errorMessage ?? null,
      finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
      startedAt: new Date(input.startedAt),
      status: input.status,
      summary: input.summary ?? {},
    })
    .returning({
      createdAt: maintenanceRuns.createdAt,
      environment: maintenanceRuns.environment,
      errorMessage: maintenanceRuns.errorMessage,
      finishedAt: maintenanceRuns.finishedAt,
      maintenanceRunId: maintenanceRuns.id,
      startedAt: maintenanceRuns.startedAt,
      status: maintenanceRuns.status,
      summary: maintenanceRuns.summary,
    });

  if (row === undefined) {
    throw new Error("Failed to persist maintenance run.");
  }

  return mapMaintenanceRunRow(row);
}

export async function getLatestMaintenanceRun(
  client: DatabaseClient,
  environment: string,
): Promise<StoredMaintenanceRun | null> {
  const [row] = await client.db
    .select({
      createdAt: maintenanceRuns.createdAt,
      environment: maintenanceRuns.environment,
      errorMessage: maintenanceRuns.errorMessage,
      finishedAt: maintenanceRuns.finishedAt,
      maintenanceRunId: maintenanceRuns.id,
      startedAt: maintenanceRuns.startedAt,
      status: maintenanceRuns.status,
      summary: maintenanceRuns.summary,
    })
    .from(maintenanceRuns)
    .where(eq(maintenanceRuns.environment, environment))
    .orderBy(desc(maintenanceRuns.startedAt))
    .limit(1);

  return row ? mapMaintenanceRunRow(row) : null;
}

export async function createQueueMetricSample(
  client: DatabaseClient,
  input: CreateQueueMetricSampleInput,
): Promise<StoredQueueMetricSample> {
  const [row] = await client.db
    .insert(queueMetricSamples)
    .values({
      active: input.counts.active,
      completed: input.counts.completed,
      delayed: input.counts.delayed,
      environment: input.environment,
      failed: input.counts.failed,
      observedAt: new Date(input.observedAt),
      queueName: input.queueName,
      waiting: input.counts.waiting,
    })
    .returning({
      active: queueMetricSamples.active,
      completed: queueMetricSamples.completed,
      delayed: queueMetricSamples.delayed,
      environment: queueMetricSamples.environment,
      failed: queueMetricSamples.failed,
      observedAt: queueMetricSamples.observedAt,
      queueName: queueMetricSamples.queueName,
      sampleId: queueMetricSamples.id,
      waiting: queueMetricSamples.waiting,
    });

  if (row === undefined) {
    throw new Error("Failed to persist queue metric sample.");
  }

  return mapQueueMetricSampleRow(row);
}

export async function listQueueMetricSamples(
  client: DatabaseClient,
  query: ListQueueMetricSamplesQuery,
): Promise<readonly StoredQueueMetricSample[]> {
  const filters = [eq(queueMetricSamples.environment, query.environment)];
  if (query.queueName !== undefined) {
    filters.push(eq(queueMetricSamples.queueName, query.queueName));
  }

  const rows = await client.db
    .select({
      active: queueMetricSamples.active,
      completed: queueMetricSamples.completed,
      delayed: queueMetricSamples.delayed,
      environment: queueMetricSamples.environment,
      failed: queueMetricSamples.failed,
      observedAt: queueMetricSamples.observedAt,
      queueName: queueMetricSamples.queueName,
      sampleId: queueMetricSamples.id,
      waiting: queueMetricSamples.waiting,
    })
    .from(queueMetricSamples)
    .where(and(...filters))
    .orderBy(desc(queueMetricSamples.observedAt))
    .limit(normalizeLimit(query.limit, 24, 240));

  return rows.map(mapQueueMetricSampleRow);
}

const EXPIRE_BATCH = 500;

/**
 * Deletes finished runs at or before the cutoff in batches, so no statement holds many rows
 * locked; attempts, steps, logs and usages cascade. A run whose terminal state is still being
 * written (`terminal_pending`) waits for the next pass.
 */
export async function expireRuns(
  client: DatabaseClient,
  input: ExpireRunsInput,
): Promise<ExpireRunsResult> {
  const expiring = and(
    inArray(runs.status, FINISHED_RUN_STATUSES),
    eq(runs.terminalPending, false),
    lte(runs.finishedAt, new Date(input.cutoff)),
  );
  let runsDeleted = 0;
  for (;;) {
    const batch = client.db.select({ id: runs.id }).from(runs).where(expiring).limit(EXPIRE_BATCH);
    const deleted = await client.db
      .delete(runs)
      .where(inArray(runs.id, batch))
      .returning({ id: runs.id });
    runsDeleted += deleted.length;
    if (deleted.length < EXPIRE_BATCH) return { runsDeleted };
  }
}

function normalizeLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), max);
}
