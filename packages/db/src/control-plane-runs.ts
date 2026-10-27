import { parseQueueTimeoutToMs } from "@swizzle/config";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  max,
  notInArray,
  or,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { CodedError } from "./coded-error.js";
import { shareLiveAutomation } from "./control-plane-automations.js";
import { getRunById } from "./control-plane-read-models.js";
import { writeStepResult } from "./control-plane-steps.js";
import type {
  CompleteRunExecutionInput,
  CreateChainJoinRunInput,
  CreateRunExecutionInput,
  CreateRunInput,
  FindSucceededChainSourceRunsInput,
  ListChildRunsInput,
  ListDueSleepingRunsInput,
  ListDueWaitingRunsInput,
  ListQueuedRunsPageInput,
  ListWaitingEventRunsInput,
  MarkRunExecutionReadyInput,
  PlatformRunStatus,
  ReassignApprovalInput,
  ResumeWaitingRunInput,
  StoredRun,
  UpdateRunExecutionHeartbeatInput,
  UpdateRunStateInput,
} from "./control-plane-types.js";
import type { ApprovalAssignee } from "./run-approval.js";
import { FINISHED_RUN_STATUSES, isFinishedRun, OPEN_RUN_STATUSES } from "./run-status.js";
import {
  automations,
  automationVersions,
  chainJoinFires,
  deployments,
  runExecutions,
  runs,
} from "./schema.js";

/**
 * When a run that queues now fails with PLACEMENT_TIMEOUT: its version's `runtime.queue_timeout`
 * from now. Every write that queues a run stores it, so the expiry pass reads one column.
 */
async function placementDeadline(
  db: Pick<DatabaseClient["db"], "select">,
  run: { readonly versionId: string } | { readonly runId: string },
): Promise<Date> {
  const [version] = await db
    .select({
      queueTimeout: sql<string>`${automationVersions.config}->'runtime'->>'queue_timeout'`,
    })
    .from(automationVersions)
    .where(
      "versionId" in run
        ? eq(automationVersions.id, run.versionId)
        : eq(
            automationVersions.id,
            sql`(select ${runs.versionId} from ${runs} where ${runs.id} = ${run.runId})`,
          ),
    );
  if (version === undefined)
    throw new CodedError("RUN_NOT_FOUND", "The run's automation version was not found.");
  return new Date(Date.now() + parseQueueTimeoutToMs(version.queueTimeout));
}

export async function countActiveRunsForAutomation(
  client: DatabaseClient,
  automationId: string,
  environment: string,
  excludeRunId?: string,
): Promise<number> {
  const rows = await client.db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(
      and(
        eq(runs.automationId, automationId),
        eq(deployments.environment, environment),
        inArray(runs.status, OPEN_RUN_STATUSES),
      ),
    );
  if (excludeRunId !== undefined) {
    return rows.filter((row) => row.id !== excludeRunId).length;
  }
  return rows.length;
}

export async function countDeadLetteredRunsSince(
  client: DatabaseClient,
  automationId: string,
  environment: string,
  since: string,
): Promise<number> {
  const rows = await client.db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(
      and(
        eq(runs.automationId, automationId),
        eq(deployments.environment, environment),
        eq(runs.status, "dead-lettered"),
        gte(runs.finishedAt, new Date(since)),
      ),
    );

  return rows.length;
}

/** A run belongs to its automation's project as it is created; a deleted automation starts none. */
async function liveProjectOf(
  tx: Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0],
  automationId: string,
): Promise<string> {
  const automation = await shareLiveAutomation(tx, eq(automations.id, automationId));
  if (automation === null) {
    throw new CodedError("AUTOMATION_NOT_FOUND", `Automation not found: ${automationId}`);
  }
  return automation.projectId;
}

async function insertRun(
  tx: Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0],
  input: CreateRunInput,
): Promise<void> {
  const projectId = await liveProjectOf(tx, input.automationId);
  await tx.insert(runs).values({
    attemptsMade: 0,
    attemptsMax: input.attemptsMax,
    automationId: input.automationId,
    projectId,
    chainOriginRunId: input.chainOriginRunId ?? null,
    chainSourceRunIds: [...(input.chainSourceRunIds ?? [])],
    correlationId: input.correlationId ?? null,
    deploymentId: input.deploymentId,
    invokeDepth: input.invokeDepth ?? 0,
    id: input.runId,
    payload: input.payload,
    parentRunId: input.parentRunId ?? null,
    parentStepKey: input.parentStepKey ?? null,
    queueJobId: input.queueJobId,
    queueName: input.queueName,
    placementDeadlineAt: await placementDeadline(tx, input),
    status: "queued",
    triggerType: input.triggerType,
    updatedAt: new Date(),
    versionId: input.versionId,
    webhookContext: input.webhookContext ?? null,
  });
}

export async function createRun(client: DatabaseClient, input: CreateRunInput): Promise<StoredRun> {
  await client.db.transaction(async (tx) => await insertRun(tx, input));

  const persistedRun = await getRunById(client, input.runId);
  if (persistedRun === null) {
    throw new Error(`Persisted run could not be reloaded: ${input.runId}`);
  }

  return persistedRun;
}

export async function createChainJoinRun(
  client: DatabaseClient,
  input: CreateChainJoinRunInput,
): Promise<StoredRun | null> {
  try {
    await client.db.transaction(async (tx) => {
      await insertRun(tx, {
        ...input,
        chainOriginRunId: input.originRunId,
        chainSourceRunIds: input.sourceRunIds,
      });

      await tx.insert(chainJoinFires).values({
        originRunId: input.originRunId,
        runId: input.runId,
        triggerId: input.triggerId,
      });
    });
  } catch (error) {
    if (isChainJoinAlreadyFired(error)) {
      return null;
    }
    throw error;
  }

  const persistedRun = await getRunById(client, input.runId);
  if (persistedRun === null) {
    throw new Error(`Persisted chain join run could not be reloaded: ${input.runId}`);
  }
  return persistedRun;
}

export async function findSucceededChainSourceRuns(
  client: DatabaseClient,
  input: FindSucceededChainSourceRunsInput,
): Promise<readonly StoredRun[]> {
  if (input.sourceAutomationIds.length === 0) {
    return [];
  }

  const rows = await client.db
    .select({
      automationId: runs.automationId,
      runId: runs.id,
    })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(
      and(
        inArray(runs.automationId, [...input.sourceAutomationIds]),
        eq(runs.chainOriginRunId, input.chainOriginRunId),
        eq(runs.status, "succeeded"),
        eq(deployments.environment, input.environment),
      ),
    )
    .orderBy(asc(runs.finishedAt), asc(runs.queuedAt), asc(runs.id));

  const selectedRunIds: string[] = [];
  const seenAutomationIds = new Set<string>();
  for (const row of rows) {
    if (seenAutomationIds.has(row.automationId)) {
      continue;
    }
    seenAutomationIds.add(row.automationId);
    selectedRunIds.push(row.runId);
  }

  const selectedRuns = await Promise.all(selectedRunIds.map((runId) => getRunById(client, runId)));
  return selectedRuns.filter((run): run is StoredRun => run !== null);
}

export async function getRun(client: DatabaseClient, runId: string): Promise<StoredRun | null> {
  return await getRunById(client, runId);
}

function isChainJoinAlreadyFired(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  const constraint = "constraint" in error ? error.constraint : undefined;
  const cause = "cause" in error ? error.cause : undefined;

  return (
    (code === "23505" && constraint === "chain_join_fires_trigger_origin_unique") ||
    isChainJoinAlreadyFired(cause)
  );
}

export async function createRunExecution(
  client: DatabaseClient,
  input: CreateRunExecutionInput,
): Promise<void> {
  await client.db.insert(runExecutions).values({
    executionNumber: input.executionNumber,
    metadata: input.metadata ?? {},
    queueJobId: input.queueJobId,
    runId: input.runId,
    attempt: input.attempt,
    startedAt: new Date(input.startedAt),
    status: input.status,
    workerName: input.workerName,
  });
}

export async function completeRunExecution(
  client: DatabaseClient,
  input: CompleteRunExecutionInput,
): Promise<void> {
  await client.db
    .update(runExecutions)
    .set({
      durationMs: input.durationMs,
      errorCause: input.errorCause ?? null,
      errorClassification: input.errorClassification ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      errorStack: input.errorStack ?? null,
      finishedAt: new Date(input.finishedAt),
      metadata: sql`${runExecutions.metadata} || ${JSON.stringify(input.metadata ?? {})}::jsonb`,
      status: input.status,
      stderr: input.stderr,
      stdout: input.stdout,
      wait: input.wait ?? null,
    })
    .where(
      and(
        eq(runExecutions.runId, input.runId),
        eq(runExecutions.executionNumber, input.executionNumber),
      ),
    );
}

export async function appendRunExecutionOutput(
  client: DatabaseClient,
  input: {
    readonly executionNumber: number;
    readonly runId: string;
    readonly stderr?: string;
    readonly stdout?: string;
  },
): Promise<void> {
  if ((input.stdout ?? "") === "" && (input.stderr ?? "") === "") {
    return;
  }

  const runValues: Partial<typeof runs.$inferInsert> = { updatedAt: new Date() };
  const executionValues: Partial<typeof runExecutions.$inferInsert> = {};

  if (input.stdout !== undefined && input.stdout.length > 0) {
    runValues.stdout = sql`${runs.stdout} || ${input.stdout}` as unknown as string;
    executionValues.stdout = sql`${runExecutions.stdout} || ${input.stdout}` as unknown as string;
  }

  if (input.stderr !== undefined && input.stderr.length > 0) {
    runValues.stderr = sql`${runs.stderr} || ${input.stderr}` as unknown as string;
    executionValues.stderr = sql`${runExecutions.stderr} || ${input.stderr}` as unknown as string;
  }

  await client.db.update(runs).set(runValues).where(eq(runs.id, input.runId));
  await client.db
    .update(runExecutions)
    .set(executionValues)
    .where(
      and(
        eq(runExecutions.runId, input.runId),
        eq(runExecutions.executionNumber, input.executionNumber),
      ),
    );
}

export async function markRunExecutionReady(
  client: DatabaseClient,
  input: MarkRunExecutionReadyInput,
): Promise<void> {
  await client.db
    .update(runExecutions)
    .set({ phase: "executing", lastHeartbeatAt: new Date() })
    .where(
      and(
        eq(runExecutions.runId, input.runId),
        eq(runExecutions.executionNumber, input.executionNumber),
        eq(runExecutions.status, "running"),
      ),
    );
}

export async function updateRunExecutionHeartbeat(
  client: DatabaseClient,
  input: UpdateRunExecutionHeartbeatInput,
): Promise<boolean> {
  const updated = await client.db
    .update(runExecutions)
    .set({
      lastHeartbeatAt: new Date(input.heartbeatAt),
    })
    .where(
      and(
        eq(runExecutions.runId, input.runId),
        eq(runExecutions.executionNumber, input.executionNumber),
        eq(runExecutions.status, "running"),
      ),
    )
    .returning({ runId: runExecutions.runId });
  return updated.length > 0;
}

export async function listDueSleepingRuns(
  client: DatabaseClient,
  input: ListDueSleepingRunsInput,
): Promise<readonly StoredRun[]> {
  const limit = input.limit ?? 50;
  const filters = [
    eq(runs.status, "waiting"),
    eq(sql`${runs.wait}->>'reason'`, "sleep"),
    lte(sql`${runs.wait}->>'until'`, new Date(input.now).toISOString()),
  ];

  if (input.environment !== undefined) {
    filters.push(eq(deployments.environment, input.environment));
  }

  const rows = await client.db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(and(...filters))
    .orderBy(asc(sql`${runs.wait}->>'until'`), asc(runs.id))
    .limit(limit);

  const resolved = await Promise.all(rows.map((row) => getRunById(client, row.runId)));
  return resolved.filter((run): run is StoredRun => run !== null);
}

export async function listDueWaitingRuns(
  client: DatabaseClient,
  input: ListDueWaitingRunsInput,
): Promise<readonly StoredRun[]> {
  const limit = input.limit ?? 50;
  const filters = [
    eq(runs.status, "waiting"),
    inArray(sql`${runs.wait}->>'reason'`, ["approval", "event", "sleep"]),
    lte(sql`${runs.wait}->>'until'`, new Date(input.now).toISOString()),
  ];

  if (input.environment !== undefined) {
    filters.push(eq(deployments.environment, input.environment));
  }

  const rows = await client.db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(and(...filters))
    .orderBy(asc(sql`${runs.wait}->>'until'`), asc(runs.id))
    .limit(limit);

  const resolved = await Promise.all(rows.map((row) => getRunById(client, row.runId)));
  return resolved.filter((run): run is StoredRun => run !== null);
}

export async function listWaitingEventRuns(
  client: DatabaseClient,
  input: ListWaitingEventRunsInput,
): Promise<readonly StoredRun[]> {
  const limit = input.limit ?? 100;
  const filters = [
    eq(runs.status, "waiting"),
    inArray(sql`${runs.wait}->>'reason'`, ["approval", "event"]),
  ];
  if (input.environment !== undefined) {
    filters.push(eq(deployments.environment, input.environment));
  }
  if (input.stepKey !== undefined) {
    filters.push(eq(sql`${runs.wait}->>'stepKey'`, input.stepKey));
  }

  const rows = await client.db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(and(...filters))
    .orderBy(asc(runs.queuedAt), asc(runs.id))
    .limit(limit);

  const resolved = await Promise.all(rows.map((row) => getRunById(client, row.runId)));
  return resolved.filter((run): run is StoredRun => run !== null);
}

export async function listChildRuns(
  client: DatabaseClient,
  input: ListChildRunsInput,
): Promise<readonly StoredRun[]> {
  const rows = await client.db
    .select({ runId: runs.id })
    .from(runs)
    .where(eq(runs.parentRunId, input.parentRunId))
    .orderBy(asc(runs.queuedAt), asc(runs.id));

  const resolved = await Promise.all(rows.map((row) => getRunById(client, row.runId)));
  return resolved.filter((run): run is StoredRun => run !== null);
}

export async function listQueuedRuns(
  client: DatabaseClient,
  input: ListQueuedRunsPageInput,
): Promise<readonly StoredRun[]> {
  const limit = input.limit ?? 50;
  // The aggregate must not reuse the raw column name: Drizzle renders the join
  // comparison against a same-named alias unqualified, which Postgres rejects
  // as an ambiguous column reference.
  const latestAttempts = client.db
    .select({
      latestAttemptNumber: sql<number>`max(${runExecutions.executionNumber})`.as(
        "latest_execution_number",
      ),
      runId: runExecutions.runId,
    })
    .from(runExecutions)
    .groupBy(runExecutions.runId)
    .as("latest_attempts");

  const filters = [
    eq(runs.status, "queued"),
    or(isNull(runExecutions.id), inArray(runExecutions.status, ["suspended", "retrying"])),
  ];
  if (input.environment !== undefined) {
    filters.push(eq(deployments.environment, input.environment));
  }
  if (input.afterRunId !== undefined) {
    filters.push(afterQueuedRun(input.afterRunId));
  }

  const rows = await client.db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .leftJoin(latestAttempts, eq(latestAttempts.runId, runs.id))
    .leftJoin(
      runExecutions,
      and(
        eq(runExecutions.runId, latestAttempts.runId),
        eq(runExecutions.executionNumber, latestAttempts.latestAttemptNumber),
      ),
    )
    .where(and(...filters))
    .orderBy(asc(runs.queuedAt), asc(runs.id))
    .limit(limit);

  const resolved = await Promise.all(rows.map((row) => getRunById(client, row.runId)));
  return resolved.filter((run): run is StoredRun => run !== null);
}

// The cursor's position comes from its own row: `queued_at` carries microseconds that a
// JavaScript Date would truncate, which would list the cursor run again.
function afterQueuedRun(runId: string) {
  return sql`(${runs.queuedAt}, ${runs.id}) > (select r.queued_at, r.id from runs r where r.id = ${runId})`;
}

export async function resumeWaitingRun(
  client: DatabaseClient,
  input: ResumeWaitingRunInput,
): Promise<StoredRun | null> {
  const resumed = await client.db
    .transaction(async (tx) => {
      const [updated] = await tx
        .update(runs)
        .set({
          placementDeadlineAt: await placementDeadline(tx, input),
          attemptsMade: 0,
          resumeCount: sql`${runs.resumeCount} + 1` as unknown as number,
          status: "queued",
          updatedAt: new Date(),
          wait: null,
        })
        .where(
          and(
            eq(runs.id, input.runId),
            eq(runs.status, "waiting"),
            eq(sql`${runs.wait}->>'reason'`, input.expectedWaitReason),
            eq(sql`${runs.wait}->>'stepKey'`, input.stepKey),
            ...(input.expectedAssignee === undefined ? [] : [assignedTo(input.expectedAssignee)]),
          ),
        )
        .returning({ runId: runs.id });
      if (!updated) return null;

      // The result belongs to the execution that suspended: the run's last.
      const [suspended] = await tx
        .select({ executionNumber: max(runExecutions.executionNumber) })
        .from(runExecutions)
        .where(eq(runExecutions.runId, input.runId));
      // A step waits at most once per run, so a result already there means the wait was over.
      const { written } = await writeStepResult(tx, {
        ...input.result,
        executionNumber: suspended?.executionNumber ?? 0,
        runId: input.runId,
        stepKey: input.stepKey,
      });
      if (!written) tx.rollback();
      return updated.runId;
    })
    .catch((error: unknown) => {
      if (error instanceof TransactionRollbackError) return null;
      throw error;
    });
  return resumed === null ? null : await getRunById(client, resumed);
}

export async function reassignApproval(
  client: DatabaseClient,
  input: ReassignApprovalInput,
): Promise<boolean> {
  const updated = await client.db
    .update(runs)
    .set({
      updatedAt: new Date(),
      wait: sql`jsonb_set(${runs.wait}, '{assignee}', ${JSON.stringify(input.to)}::jsonb)`,
    })
    .where(
      and(
        eq(runs.id, input.runId),
        eq(runs.status, "waiting"),
        eq(sql`${runs.wait}->>'reason'`, "approval"),
        eq(sql`${runs.wait}->>'stepKey'`, input.stepKey),
        assignedTo(input.from),
      ),
    )
    .returning({ runId: runs.id });
  return updated.length > 0;
}

function assignedTo(assignee: ApprovalAssignee | null) {
  return assignee === null
    ? sql`(${runs.wait}->'assignee') = 'null'::jsonb`
    : sql`${runs.wait}->'assignee' = ${JSON.stringify(assignee)}::jsonb`;
}

export async function updateRunState(
  client: DatabaseClient,
  input: UpdateRunStateInput,
): Promise<void> {
  const values: Partial<typeof runs.$inferInsert> & { status: PlatformRunStatus } = {
    status: input.status,
    updatedAt: new Date(),
  };

  // A run that queues again gets a fresh wait; one already queued keeps its deadline.
  if (input.status === "queued") {
    values.placementDeadlineAt =
      sql`case when ${runs.status} = 'queued' then ${runs.placementDeadlineAt} else ${await placementDeadline(client.db, input)} end` as unknown as Date;
  }

  if (input.attemptsMade !== undefined) {
    values.attemptsMade = input.attemptsMade;
  }

  if (input.deadLetterReason !== undefined) {
    values.deadLetterReason = input.deadLetterReason;
  }

  if (input.errorClassification !== undefined) {
    values.errorClassification = input.errorClassification;
  }

  if (input.errorCode !== undefined) {
    values.errorCode = input.errorCode;
  }

  if (input.errorMessage !== undefined) {
    values.errorMessage = input.errorMessage;
  }

  if (input.errorStack !== undefined) {
    values.errorStack = input.errorStack;
  }

  if (input.errorCause !== undefined) {
    values.errorCause = input.errorCause;
  }

  if (input.finishedAt !== undefined) {
    values.finishedAt = input.finishedAt === null ? null : new Date(input.finishedAt);
  }

  if (input.result !== undefined) {
    values.result = input.result;
  }

  if (input.startedAt !== undefined) {
    values.startedAt = input.startedAt === null ? null : new Date(input.startedAt);
  }

  if (input.stderr !== undefined) {
    values.stderr = input.stderr;
  }

  if (input.stdout !== undefined) {
    values.stdout = input.stdout;
  }

  if (input.wait !== undefined) values.wait = input.wait;

  await client.db
    .update(runs)
    .set(values)
    .where(
      and(
        eq(runs.id, input.runId),
        or(notInArray(runs.status, FINISHED_RUN_STATUSES), eq(runs.status, input.status)),
      ),
    );
}

/** Serializes cancellation with a leased result's run lock. */
export async function cancelRun(
  client: DatabaseClient,
  input: { readonly runId: string; readonly finishedAt: string },
) {
  return await client.db.transaction(async (tx) => {
    const [row] = await tx.select().from(runs).where(eq(runs.id, input.runId)).for("update");
    if (row === undefined) throw new CodedError("RUN_NOT_FOUND", "Run not found.");
    const scoped = { ...client, db: tx };
    if (isFinishedRun(row.status)) {
      const run = await getRunById(scoped, input.runId);
      if (run === null) throw new Error("Locked run disappeared.");
      return { alreadyTerminal: true, run };
    }
    const finishedAt = new Date(input.finishedAt);
    await tx
      .update(runExecutions)
      .set({
        status: "dead-lettered",
        finishedAt,
        errorClassification: "terminal",
        errorCode: "RUN_CANCELLED",
        errorMessage: "Run cancelled by user.",
        durationMs: sql`greatest(0, floor(extract(epoch from (${finishedAt}::timestamptz - ${runExecutions.startedAt})) * 1000))::int`,
      })
      .where(and(eq(runExecutions.runId, row.id), eq(runExecutions.status, "running")));
    await updateRunState(scoped, {
      runId: row.id,
      status: "dead-lettered",
      finishedAt: input.finishedAt,
      errorCode: "RUN_CANCELLED",
      errorClassification: "terminal",
      errorMessage: "Run cancelled by user.",
      deadLetterReason: "user-cancelled",
      wait: null,
    });
    const run = await getRunById(scoped, row.id);
    if (run === null) throw new Error("Locked run disappeared.");
    return { alreadyTerminal: false, run };
  });
}
