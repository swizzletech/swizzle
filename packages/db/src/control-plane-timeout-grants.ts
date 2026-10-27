import { and, eq, sql } from "drizzle-orm";
import type { AuditEventOf, TimeoutGrantAuditEventType } from "./audit.js";
import { auditEventsOf } from "./audit.js";
import { recordTimeoutGrantChange } from "./audit-resources.js";
import { createPostgresAuditStore } from "./audit-tables.js";

import type { DatabaseClient } from "./client.js";
import type {
  AutomationTimeoutGrantKeyInput,
  ListTimeoutGrantAuditEventsInput,
  SetAutomationTimeoutGrantInput,
  StoredTimeoutGrant,
} from "./control-plane-types.js";
import { automations, automationTimeoutGrants } from "./schema.js";

const GRANT_SELECTION = {
  automationId: automationTimeoutGrants.automationId,
  automationName: automations.name,
  automationSlug: automations.slug,
  createdAt: automationTimeoutGrants.createdAt,
  environment: automationTimeoutGrants.environment,
  maxTimeoutMs: automationTimeoutGrants.maxTimeoutMs,
  note: automationTimeoutGrants.note,
};

function mapGrantRow(row: {
  automationId: string;
  automationName: string;
  automationSlug: string;
  createdAt: Date;
  environment: string;
  maxTimeoutMs: number;
  note: string | null;
}): StoredTimeoutGrant {
  return {
    automationId: row.automationId,
    automationName: row.automationName,
    automationSlug: row.automationSlug,
    createdAt: row.createdAt.toISOString(),
    environment: row.environment,
    maxTimeoutMs: row.maxTimeoutMs,
    note: row.note,
  };
}

export async function getAutomationTimeoutGrant(
  client: DatabaseClient,
  input: AutomationTimeoutGrantKeyInput,
): Promise<StoredTimeoutGrant | null> {
  const [row] = await client.db
    .select(GRANT_SELECTION)
    .from(automationTimeoutGrants)
    .innerJoin(automations, eq(automationTimeoutGrants.automationId, automations.id))
    .where(
      and(
        eq(automationTimeoutGrants.automationId, input.automationId),
        eq(automationTimeoutGrants.environment, input.environment),
      ),
    )
    .limit(1);

  return row ? mapGrantRow(row) : null;
}

export async function listAutomationTimeoutGrants(
  client: DatabaseClient,
  environment: string,
): Promise<readonly StoredTimeoutGrant[]> {
  const rows = await client.db
    .select(GRANT_SELECTION)
    .from(automationTimeoutGrants)
    .innerJoin(automations, eq(automationTimeoutGrants.automationId, automations.id))
    .where(eq(automationTimeoutGrants.environment, environment))
    .orderBy(automations.slug);

  return rows.map(mapGrantRow);
}

export async function setAutomationTimeoutGrant(
  client: DatabaseClient,
  input: SetAutomationTimeoutGrantInput,
): Promise<StoredTimeoutGrant> {
  const note = input.note ?? null;

  await client.db.transaction(async (tx) => {
    // Lock any existing grant so a concurrent writer can't race the audit trail
    // out of order, then read the previous ceiling for the audit metadata.
    // FOR UPDATE cannot lock a row that does not exist yet; without this,
    // two concurrent first-time upserts both audit previousMaxTimeoutMs: null.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`timeout-grant:${input.automationId}:${input.environment}`}, 0))`,
    );
    const [existing] = await tx
      .select({ maxTimeoutMs: automationTimeoutGrants.maxTimeoutMs })
      .from(automationTimeoutGrants)
      .where(
        and(
          eq(automationTimeoutGrants.automationId, input.automationId),
          eq(automationTimeoutGrants.environment, input.environment),
        ),
      )
      .limit(1)
      .for("update");

    await tx
      .insert(automationTimeoutGrants)
      .values({
        automationId: input.automationId,
        environment: input.environment,
        maxTimeoutMs: input.maxTimeoutMs,
        note,
      })
      .onConflictDoUpdate({
        set: {
          maxTimeoutMs: input.maxTimeoutMs,
          note,
        },
        target: [automationTimeoutGrants.automationId, automationTimeoutGrants.environment],
      });

    await recordTimeoutGrantChange(tx, {
      automationId: input.automationId,
      environment: input.environment,
      eventType: "timeout_grant_set" satisfies TimeoutGrantAuditEventType,
      metadata: {
        maxTimeoutMs: input.maxTimeoutMs,
        note,
        previousMaxTimeoutMs: existing?.maxTimeoutMs ?? null,
      },
    });
  });

  const persisted = await getAutomationTimeoutGrant(client, input);
  if (persisted === null) {
    throw new Error(
      `Timeout grant could not be reloaded: ${input.environment}/${input.automationId}`,
    );
  }
  return persisted;
}

export async function deleteAutomationTimeoutGrant(
  client: DatabaseClient,
  input: AutomationTimeoutGrantKeyInput,
): Promise<boolean> {
  return await client.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(automationTimeoutGrants)
      .where(
        and(
          eq(automationTimeoutGrants.automationId, input.automationId),
          eq(automationTimeoutGrants.environment, input.environment),
        ),
      )
      .returning({ maxTimeoutMs: automationTimeoutGrants.maxTimeoutMs });

    const removed = deleted[0];
    if (!removed) {
      return false;
    }

    await recordTimeoutGrantChange(tx, {
      automationId: input.automationId,
      environment: input.environment,
      eventType: "timeout_grant_removed" satisfies TimeoutGrantAuditEventType,
      metadata: {
        previousMaxTimeoutMs: removed.maxTimeoutMs,
      },
    });

    return true;
  });
}

export async function listAutomationTimeoutGrantAuditEvents(
  client: DatabaseClient,
  input: ListTimeoutGrantAuditEventsInput,
): Promise<readonly AuditEventOf<"timeout-grant">[]> {
  return auditEventsOf(
    "timeout-grant",
    await createPostgresAuditStore({ client }).list({
      automation: input.automationId,
      environments: [input.environment],
      projectIds: null,
      kind: "timeout-grant",
      limit: input.limit ?? 50,
    }),
  );
}
