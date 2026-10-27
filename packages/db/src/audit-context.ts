/** One request scope links resource changes to the event begun at the HTTP boundary. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AuditActor, AuditEvent, RecordAuditChange } from "./audit.js";
import { NO_AUDIT_TARGET } from "./audit.js";

export const auditScope = new AsyncLocalStorage<{
  eventId: string | null;
  readonly requestId: string;
  actor: AuditActor;
}>();

export function auditActorId(actor: AuditActor): string | null {
  switch (actor.kind) {
    case "person":
      return actor.userId;
    case "service-account":
      return actor.serviceAccountId;
    case "worker":
      return actor.workerId;
    default:
      return null;
  }
}

export function changeEvent(input: RecordAuditChange): Omit<AuditEvent, "id"> {
  const scope = auditScope.getStore();
  const change = input.change;
  const target =
    change.kind === "worker"
      ? NO_AUDIT_TARGET
      : {
          automationId: change.automationId,
          automationSlug: "automationSlug" in change ? change.automationSlug : null,
          environment: change.environment,
          projectId: change.projectId,
          runId: "runId" in change ? change.runId : null,
        };
  return {
    change,
    occurredAt: input.occurredAt,
    actor: input.actor ?? scope?.actor ?? { kind: "system" },
    action: change.kind === "worker" ? `worker.${change.action}` : change.eventType,
    params: {},
    target,
    privileged: false,
    status: null,
    details: null,
    requestId: scope?.requestId ?? "system",
  };
}

/** Reserve synchronously; a failed insert releases only the reservation it owns. */
export async function insertAuditEvent<T>(insert: (id: string) => T | Promise<T>): Promise<T> {
  const scope = auditScope.getStore();
  if (scope !== undefined && scope.eventId !== null)
    throw new Error("This request already has an audit event.");
  const id = randomUUID();
  if (scope !== undefined) scope.eventId = id;
  try {
    return await insert(id);
  } catch (error) {
    if (scope?.eventId === id) scope.eventId = null;
    throw error;
  }
}
