import { and, eq, ne, sql } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { CodedError } from "./coded-error.js";
import type {
  ClaimAutomationStateKeyInput,
  DeleteAutomationStateValueInput,
  GetAutomationStateValueInput,
  ListAutomationStateInput,
  SetAutomationStateValueInput,
  StoredAutomationStateEntry,
} from "./control-plane-types.js";
import { automationState } from "./schema.js";

const MAX_STATE_VALUE_BYTES = 64 * 1024;
const MAX_STATE_TOTAL_BYTES = 5 * 1024 * 1024;

export async function listAutomationState(
  client: DatabaseClient,
  input: ListAutomationStateInput,
): Promise<readonly StoredAutomationStateEntry[]> {
  const rows = await client.db
    .select()
    .from(automationState)
    .where(
      and(
        eq(automationState.automationId, input.automationId),
        eq(automationState.environment, input.environment),
      ),
    )
    .orderBy(automationState.key);

  return rows.map(toStoredAutomationStateEntry);
}

export async function getAutomationStateValue(
  client: DatabaseClient,
  input: GetAutomationStateValueInput,
): Promise<StoredAutomationStateEntry | null> {
  const [row] = await client.db
    .select()
    .from(automationState)
    .where(
      and(
        eq(automationState.automationId, input.automationId),
        eq(automationState.environment, input.environment),
        eq(automationState.key, input.key),
      ),
    )
    .limit(1);

  return row ? toStoredAutomationStateEntry(row) : null;
}

export async function setAutomationStateValue(
  client: DatabaseClient,
  input: SetAutomationStateValueInput,
): Promise<StoredAutomationStateEntry> {
  const value = measureStateValue(input.key, input.value);
  return await client.db.transaction(async (tx) => {
    await lockStateNamespace(tx, input);
    return await writeStateValue(tx, input, value);
  });
}

/**
 * Claims `key` for `runId` in the automation's state: stores `{ runId }` when the key is unset,
 * and answers whether the key's holder is this run. Concurrent claims of one key queue on the
 * namespace lock, so exactly one run holds it. The holder's retries and resumes claim it again.
 */
export async function claimAutomationStateKey(
  client: DatabaseClient,
  input: ClaimAutomationStateKeyInput,
): Promise<boolean> {
  return await client.db.transaction(async (tx) => {
    await lockStateNamespace(tx, input);
    const [held] = await tx
      .select({ value: automationState.value })
      .from(automationState)
      .where(
        and(
          eq(automationState.automationId, input.automationId),
          eq(automationState.environment, input.environment),
          eq(automationState.key, input.key),
        ),
      )
      .limit(1);
    if (held !== undefined) {
      const holder = held.value as { readonly runId?: unknown } | null;
      return typeof holder === "object" && holder !== null && holder.runId === input.runId;
    }
    const claim = { runId: input.runId };
    await writeStateValue(tx, input, measureStateValue(input.key, claim));
    return true;
  });
}

type Transaction = Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0];

interface MeasuredStateValue {
  readonly serialized: string;
  readonly valueBytes: number;
}

function measureStateValue(key: string, value: unknown): MeasuredStateValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new CodedError(
      "AUTOMATION_STATE_LIMIT_EXCEEDED",
      `State value "${key}" must be JSON-serializable.`,
      { details: { key } },
    );
  }
  const valueBytes = Buffer.byteLength(serialized, "utf8");
  if (valueBytes > MAX_STATE_VALUE_BYTES) {
    throw new CodedError(
      "AUTOMATION_STATE_LIMIT_EXCEEDED",
      `State value "${key}" is ${valueBytes} bytes; max is ${MAX_STATE_VALUE_BYTES} bytes.`,
      { details: { key, limitBytes: MAX_STATE_VALUE_BYTES, valueBytes } },
    );
  }
  return { serialized, valueBytes };
}

// The namespace can have no rows yet. Lock it before reading the total, including when this is a
// savepoint inside an execution lease transaction. The lock lasts until commit.
async function lockStateNamespace(
  tx: Transaction,
  input: { readonly automationId: string; readonly environment: string },
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`automation-state:${input.automationId}:${input.environment}`}, 0))`,
  );
}

/** Writes one value under the namespace lock, refusing it when the namespace would exceed 5 MB. */
async function writeStateValue(
  tx: Transaction,
  input: Omit<SetAutomationStateValueInput, "value">,
  { serialized, valueBytes }: MeasuredStateValue,
): Promise<StoredAutomationStateEntry> {
  const [total] = await tx
    .select({
      bytes: sql<number>`coalesce(sum(${automationState.valueBytes}), 0)`.mapWith(Number),
    })
    .from(automationState)
    .where(
      and(
        eq(automationState.automationId, input.automationId),
        eq(automationState.environment, input.environment),
        ne(automationState.key, input.key),
      ),
    );
  const totalBytes = (total?.bytes ?? 0) + valueBytes;
  if (totalBytes > MAX_STATE_TOTAL_BYTES) {
    throw new CodedError(
      "AUTOMATION_STATE_LIMIT_EXCEEDED",
      `Automation state would be ${totalBytes} bytes; max is ${MAX_STATE_TOTAL_BYTES} bytes.`,
      { details: { key: input.key, limitBytes: MAX_STATE_TOTAL_BYTES, totalBytes } },
    );
  }
  const value = sql`${serialized}::jsonb`;
  const [row] = await tx
    .insert(automationState)
    .values({
      automationId: input.automationId,
      environment: input.environment,
      key: input.key,
      updatedAt: new Date(input.updatedAt),
      value,
      valueBytes,
    })
    .onConflictDoUpdate({
      set: { updatedAt: new Date(input.updatedAt), value, valueBytes },
      target: [automationState.automationId, automationState.environment, automationState.key],
    })
    .returning();
  if (row === undefined)
    throw new Error(`Automation state value could not be written: ${input.key}`);
  return toStoredAutomationStateEntry(row);
}

export async function deleteAutomationStateValue(
  client: DatabaseClient,
  input: DeleteAutomationStateValueInput,
): Promise<boolean> {
  const deleted = await client.db
    .delete(automationState)
    .where(
      and(
        eq(automationState.automationId, input.automationId),
        eq(automationState.environment, input.environment),
        eq(automationState.key, input.key),
      ),
    )
    .returning({ key: automationState.key });

  return deleted.length > 0;
}

function toStoredAutomationStateEntry(
  row: typeof automationState.$inferSelect,
): StoredAutomationStateEntry {
  return {
    automationId: row.automationId,
    environment: row.environment,
    key: row.key,
    updatedAt: row.updatedAt.toISOString(),
    value: row.value,
  };
}
