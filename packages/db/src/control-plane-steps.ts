import { and, eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import type {
  GetRunStepTotalsInput,
  ListRunStepsInput,
  RunStepTotals,
  SetRunStepResultInput,
  StartRunStepInput,
  StoredRunStepEntry,
} from "./control-plane-types.js";
import { stepResultBytes, stepResultView, storedStepResult } from "./run-approval.js";
import { runSteps, runs } from "./schema.js";

// One row per (run, step key). step_start inserts it; step_result fills in the value and
// finishedAt. A finished row never changes again, so the first result wins and a later attempt's
// step_start for a step that already has a result is ignored. Every write goes through writeStep,
// which keeps the run's step totals, so the step limits read two numbers instead of every step.

type RunStepRow = typeof runSteps.$inferSelect;
type RunStepWrite = Pick<
  typeof runSteps.$inferInsert,
  "executionNumber" | "finishedAt" | "startedAt" | "updatedAt" | "value"
>;

export async function listRunSteps(
  client: DatabaseClient,
  input: ListRunStepsInput,
): Promise<readonly StoredRunStepEntry[]> {
  const rows = await client.db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, input.runId))
    .orderBy(runSteps.stepKey);

  return rows.map(toStoredRunStepEntry);
}

export async function getRunStepTotals(
  client: DatabaseClient,
  input: GetRunStepTotalsInput,
): Promise<RunStepTotals> {
  const [row] = await client.db
    .select({ resultBytes: runs.stepResultBytes, step: runSteps, steps: runs.stepCount })
    .from(runs)
    .leftJoin(runSteps, and(eq(runSteps.runId, runs.id), eq(runSteps.stepKey, input.stepKey)))
    .where(eq(runs.id, input.runId));
  if (row === undefined) throw new Error(`Run not found: ${input.runId}`);
  return {
    resultBytes: row.resultBytes,
    step: row.step === null ? null : toStoredRunStepEntry(row.step),
    steps: row.steps,
  };
}

export async function startRunStep(
  client: DatabaseClient,
  input: StartRunStepInput,
): Promise<StoredRunStepEntry> {
  const startedAt = new Date(input.startedAt);
  const { row } = await client.db.transaction((tx) =>
    writeStep(tx, input, {
      insert: {
        executionNumber: input.executionNumber,
        startedAt,
        updatedAt: startedAt,
        value: null,
      },
      resultBytes: 0,
      update: { executionNumber: input.executionNumber, startedAt, updatedAt: startedAt },
    }),
  );
  return toStoredRunStepEntry(row);
}

export async function setRunStepResult(
  client: DatabaseClient,
  input: SetRunStepResultInput,
): Promise<StoredRunStepEntry> {
  const { row } = await client.db.transaction((tx) => writeStepResult(tx, input));
  return toStoredRunStepEntry(row);
}

/** Stores a step's result unless the step already has one; `written` is false then. */
export async function writeStepResult(
  db: DatabaseClient["db"],
  input: SetRunStepResultInput,
): Promise<{ readonly row: RunStepRow; readonly written: boolean }> {
  const now = new Date();
  const write = {
    executionNumber: input.executionNumber,
    finishedAt: now,
    updatedAt: now,
    value: storedStepResult(input),
  };
  return await writeStep(db, input, {
    insert: write,
    resultBytes: stepResultBytes(input),
    update: write,
  });
}

/**
 * Inserts or updates the row of `stepKey` under a lock on the run row, and adds the new row and
 * the result's bytes to the run's totals. The lock serializes the run's step writes, so each row
 * and each result counts exactly once. A finished row is returned unchanged with `written: false`.
 */
async function writeStep(
  db: DatabaseClient["db"],
  key: { readonly runId: string; readonly stepKey: string },
  change: {
    readonly insert: RunStepWrite;
    readonly resultBytes: number;
    readonly update: Partial<RunStepWrite>;
  },
): Promise<{ readonly row: RunStepRow; readonly written: boolean }> {
  const [locked] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, key.runId))
    .for("update");
  if (locked === undefined) throw new Error(`Run not found: ${key.runId}`);
  // A separate statement: under READ COMMITTED it takes its snapshot after the lock, so it sees
  // the row a writer that held the lock before us committed.
  const [prior = null] = await db
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, key.runId), eq(runSteps.stepKey, key.stepKey)));
  if (prior !== null && prior.finishedAt !== null) return { row: prior, written: false };

  const [row] =
    prior === null
      ? await db
          .insert(runSteps)
          .values({ ...change.insert, runId: key.runId, stepKey: key.stepKey })
          .returning()
      : await db.update(runSteps).set(change.update).where(eq(runSteps.id, prior.id)).returning();
  if (row === undefined) throw new Error(`Run step could not be written: ${key.stepKey}`);
  await db
    .update(runs)
    .set({
      stepCount: sql`${runs.stepCount} + ${prior === null ? 1 : 0}`,
      stepResultBytes: sql`${runs.stepResultBytes} + ${change.resultBytes}`,
    })
    .where(eq(runs.id, key.runId));
  return { row, written: true };
}

function toStoredRunStepEntry(row: RunStepRow): StoredRunStepEntry {
  return {
    executionNumber: row.executionNumber,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    runId: row.runId,
    startedAt: row.startedAt?.toISOString() ?? null,
    stepKey: row.stepKey,
    updatedAt: row.updatedAt.toISOString(),
    ...stepResultView(row.value),
  };
}
