/** The instance audit over PostgreSQL. Resource writers enrich the same rows inside their transactions. */

import { and, asc, type Column, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";

import { parseInstanceRole } from "./access.js";
import {
  AUDIT_CHANGE_REFUSED,
  type AuditActor,
  type AuditEvent,
  type AuditStore,
  type AuditTarget,
  mergeAuditTarget,
  type RecordAuditChange,
} from "./audit.js";
import { auditActorId, auditScope, changeEvent, insertAuditEvent } from "./audit-context.js";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { auditEvents } from "./schema.js";

type Row = typeof auditEvents.$inferSelect;
type NewRow = typeof auditEvents.$inferInsert;

export function createPostgresAuditStore(
  options: { readonly client?: DatabaseClient; readonly connectionString?: string } = {},
): AuditStore {
  const client =
    options.client ??
    createDatabaseClient(
      options.connectionString !== undefined ? { connectionString: options.connectionString } : {},
    );
  const ownsClient = options.client === undefined;
  const { db } = client;

  return {
    async close() {
      if (ownsClient) await client.close();
    },

    async begin(event) {
      return await insertAuditEvent(async (id) => {
        const [row] = await db
          .insert(auditEvents)
          .values({ ...rowOf({ ...event, change: null, status: null }), id })
          .returning({ id: auditEvents.id });
        if (row === undefined) throw new Error("The audit event was not written.");
        return row.id;
      });
    },

    async describe(id, facts) {
      await db
        .update(auditEvents)
        .set({
          ...targetUpdate(facts.target),
          details: facts.details === null ? null : { ...facts.details },
          privileged: facts.privileged,
        })
        .where(and(eq(auditEvents.id, id), isNull(auditEvents.status)));
    },

    async finish(id, status) {
      await db
        .update(auditEvents)
        .set({ status })
        .where(and(eq(auditEvents.id, id), isNull(auditEvents.status)));
    },

    async record(input) {
      await recordAuditChange(db, input);
    },
    async list(query) {
      const filters: SQL[] = [];
      if (query.kind !== undefined)
        filters.push(sql`${auditEvents.change}->>'kind' = ${query.kind}`);
      if (query.workerId !== undefined) {
        if (!isUuid(query.workerId)) return [];
        filters.push(eq(auditEvents.workerId, query.workerId));
      }
      if (query.projectIds !== null) {
        if (query.projectIds.length === 0) return [];
        filters.push(inArray(auditEvents.projectId, [...query.projectIds]));
      }
      if (query.environments !== null) {
        if (query.environments.length === 0) return [];
        filters.push(inArray(auditEvents.environment, [...query.environments]));
      }
      if (query.automation !== undefined) {
        const byName = or(
          eq(auditEvents.automationSlug, query.automation),
          ...(isUuid(query.automation) ? [eq(auditEvents.automationId, query.automation)] : []),
        );
        if (byName !== undefined) filters.push(byName);
      }
      if (query.actorId !== undefined) {
        if (!isUuid(query.actorId)) return [];
        filters.push(eq(auditEvents.actorId, query.actorId));
      }
      if (query.before !== undefined) {
        if (!isUuid(query.before)) return [];
        filters.push(
          sql`(${auditEvents.occurredAt}, ${auditEvents.id}) < (select a.occurred_at, a.id from audit_events a where a.id = ${query.before})`,
        );
      }
      const selection = db
        .select()
        .from(auditEvents)
        .where(and(...filters))
        .orderBy(
          ...(query.order === "oldest"
            ? [asc(auditEvents.occurredAt), asc(auditEvents.id)]
            : [desc(auditEvents.occurredAt), desc(auditEvents.id)]),
        );
      const rows = await (query.limit === null ? selection : selection.limit(query.limit));
      return rows.map(auditEventOf);
    },
  };
}

function rowOf(event: Omit<AuditEvent, "id" | "occurredAt">): NewRow {
  const { actor } = event;
  return {
    ...resourceColumns(event.change),
    change: event.change,
    action: event.action,
    actorId: auditActorId(actor),
    actorKind: actor.kind,
    actorLabel: "label" in actor ? actor.label : null,
    actorRole: actor.kind === "person" ? actor.role : null,
    details: event.details === null ? null : { ...event.details },
    params: { ...event.params },
    privileged: event.privileged,
    requestId: event.requestId,
    status: event.status,
    tokenId: actor.kind === "person" || actor.kind === "service-account" ? actor.tokenId : null,
    ...targetColumns(event.target),
  };
}

function targetColumns(target: AuditEvent["target"]) {
  return {
    automationId: target.automationId,
    automationSlug: target.automationSlug,
    environment: target.environment,
    projectId: target.projectId,
    runId: target.runId,
  };
}

export function auditEventOf(row: Row): AuditEvent {
  return {
    change: row.change,
    action: row.action,
    actor: actorOf(row),
    details: row.details,
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    params: row.params,
    privileged: row.privileged,
    requestId: row.requestId,
    status: row.status,
    target: {
      automationId: row.automationId,
      automationSlug: row.automationSlug,
      environment: row.environment,
      projectId: row.projectId,
      runId: row.runId,
    },
  };
}

function actorOf(row: Row): AuditActor {
  const label = row.actorLabel ?? "";
  switch (row.actorKind) {
    case "person":
      return {
        kind: "person",
        label,
        role: parseInstanceRole(row.actorRole),
        tokenId: row.tokenId,
        userId: row.actorId ?? "",
      };
    case "service-account":
      return {
        kind: "service-account",
        label,
        serviceAccountId: row.actorId ?? "",
        tokenId: row.tokenId ?? "",
      };
    case "worker":
      return { kind: "worker", workerId: row.actorId ?? "", label };
    case "system":
      return { kind: "system" };
    case "host":
      return { kind: "host" };
    case "link":
      return { kind: "link" };
    case "anonymous":
      return { kind: "anonymous" };
    default:
      throw new Error(`Unknown audit actor kind: ${row.actorKind}`);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

/** Resource writers use their own transaction, enriching the already durable request row. */
export async function recordAuditChange(
  db: DatabaseClient["db"],
  input: RecordAuditChange,
): Promise<void> {
  const event = changeEvent(input);
  const scope = auditScope.getStore();
  if (scope?.eventId !== null && scope?.eventId !== undefined) {
    const updated = await db
      .update(auditEvents)
      .set({
        ...targetUpdate(event.target),
        ...resourceColumns(input.change),
        change: input.change,
      })
      .where(
        and(
          eq(auditEvents.id, scope.eventId),
          isNull(auditEvents.status),
          isNull(auditEvents.change),
        ),
      )
      .returning({ id: auditEvents.id });
    if (updated.length !== 1) throw new Error(AUDIT_CHANGE_REFUSED);
  } else {
    await insertAuditEvent(async (id) => {
      await db
        .insert(auditEvents)
        .values({ ...rowOf(event), id, occurredAt: new Date(input.occurredAt) });
    });
  }
}

function resourceColumns(change: AuditEvent["change"]) {
  return {
    deploymentId: change !== null && "deploymentId" in change ? change.deploymentId : null,
    triggerId: change?.kind === "trigger" ? change.triggerId : null,
    workerId: change?.kind === "worker" ? change.workerId : null,
  };
}

function targetUpdate(learned: Partial<AuditTarget>) {
  return mergeAuditTarget<Column, SQL>(
    auditEvents,
    learned,
    (column, value) => sql`coalesce(${column}, ${value})`,
  );
}
