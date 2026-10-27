/**
 * The instance audit (ADR 0014): who changed what, through which token, in which project. The
 * API writes one event for each writing request (apps/api/src/request-audit.ts) before
 * the change runs, describes its target and details as the request learns them, still before the
 * change, and completes it with the status afterwards, so no change goes unrecorded or unexplained.
 * A read creates no event.
 *
 * Events name projects, automations, runs and people by id with a label as it was then, and hold
 * no foreign key: deleting an automation, a project or a person leaves its history readable.
 * An event never holds a request body, so no secret value, password, token or link is in it.
 */
import type { AutomationConfig, AutomationRuntimeConfig } from "@swizzle/config";
import type { AuditActor } from "./audit-actor.js";

export type { AuditActor } from "./audit-actor.js";

/** What an event is about, as far as the request named or the access check resolved it. */
export interface AuditTarget {
  readonly projectId: string | null;
  readonly automationId: string | null;
  readonly automationSlug: string | null;
  readonly runId: string | null;
  readonly environment: string | null;
}

export const NO_AUDIT_TARGET: AuditTarget = {
  automationId: null,
  automationSlug: null,
  environment: null,
  projectId: null,
  runId: null,
};

export type TriggerAuditEventType =
  | "chain_join_skipped"
  | "cron_skipped"
  | "trigger_paused"
  | "trigger_resumed"
  | "webhook_rejected";

export type DeploymentAuditEventType = "deploy" | "rollback";

export type TimeoutGrantAuditEventType = "timeout_grant_removed" | "timeout_grant_set";

export interface DeploymentDiff {
  readonly entrypointChanged: boolean;
  readonly executionMode: string;
  readonly executionModeChanged: boolean;
  readonly language: string;
  readonly languageChanged: boolean;
  readonly previousEntrypoint: string | null;
  readonly previousExecutionMode: string | null;
  readonly previousLanguage: string | null;
  readonly previousProfile: string | null;
  readonly previousRequirements: AutomationRuntimeConfig["requirements"] | null;
  readonly previousSecrets: readonly string[];
  readonly previousVars: Record<string, string | number | boolean>;
  readonly previousTriggerType: string | null;
  readonly previousVersion: string | null;
  readonly profile: string;
  readonly profileChanged: boolean;
  readonly requirements: AutomationRuntimeConfig["requirements"];
  readonly requirementsChanged: boolean;
  readonly secrets: readonly string[];
  readonly secretsAdded: readonly string[];
  readonly secretsRemoved: readonly string[];
  readonly sourceHashChanged: boolean;
  readonly triggerType: string;
  readonly triggerTypeChanged: boolean;
  readonly version: string;
  readonly versionChanged: boolean;
  readonly vars: Record<string, string | number | boolean>;
  readonly varsChanged: boolean;
}

/** Resource changes share the same audit envelope as writing requests. */
export type AuditChange =
  | {
      readonly kind: "trigger";
      readonly automationId: string;
      readonly automationName: string;
      readonly automationSlug: string;
      readonly deploymentId: string;
      readonly environment: string;
      readonly eventType: TriggerAuditEventType;
      readonly metadata: Record<string, unknown>;
      /** The project the automation was in when this happened. */
      readonly projectId: string;
      readonly runId: string | null;
      /** The trigger id at the time of the event, kept after deletion. */
      readonly triggerId: string;
      readonly triggerType: AutomationConfig["trigger"]["type"];
    }
  | {
      readonly kind: "deployment";
      readonly automationId: string;
      /** The project the automation was in when this happened. */
      readonly projectId: string;
      readonly deploymentId: string;
      readonly diff: DeploymentDiff | null;
      readonly environment: string;
      readonly eventType: DeploymentAuditEventType;
      readonly metadata: Record<string, unknown>;
      readonly previousDeploymentId: string | null;
      readonly previousSourceHash: string | null;
      readonly previousVersion: string | null;
      readonly sourceHash: string;
      readonly version: string;
      readonly automationSlug: string;
    }
  | {
      readonly kind: "timeout-grant";
      readonly automationId: string;
      readonly projectId: string;
      readonly environment: string;
      readonly eventType: TimeoutGrantAuditEventType;
      readonly metadata: Record<string, unknown>;
      readonly automationSlug: string;
    }
  | {
      readonly kind: "worker";
      readonly workerId: string;
      readonly action: "created" | "enrolled" | "revoked" | "renewed" | "scope-denied";
      readonly issuedBy: string | null;
    };

export interface RecordAuditChange {
  readonly change: AuditChange;
  readonly occurredAt: string;
  readonly actor?: AuditActor;
}

export interface AuditEvent {
  readonly change: AuditChange | null;
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: AuditActor;
  /** The route as `METHOD /path/:param`, or the resource event type outside a request. */
  readonly action: string;
  /** The route's path parameters: names and ids, never a value from the body. */
  readonly params: Readonly<Record<string, string>>;
  readonly target: AuditTarget;
  /** True when only the actor's instance role allowed it, not a grant on the project. */
  readonly privileged: boolean;
  /** The HTTP status; null outside HTTP, while a request runs, or if it never finished. */
  readonly status: number | null;
  /** What a route adds, such as the reason for a reassignment. */
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly requestId: string;
}

export interface AuditQuery {
  /** Only these projects; null for every project and for events of no project. */
  readonly projectIds: readonly string[] | null;
  /** Only these environments; null for any environment and for events of none. */
  readonly environments: readonly string[] | null;
  /** Events of an automation by id or by the name it had then, deleted ones included. */
  readonly automation?: string;
  /** Events of one person, service account or worker by id. */
  readonly actorId?: string;
  readonly kind?: AuditChange["kind"];
  readonly workerId?: string;
  readonly order?: "newest" | "oldest";
  /** Only events older than this event, for the next page. */
  readonly before?: string;
  /** Null reads the complete resource history; HTTP queries always supply a bounded limit. */
  readonly limit: number | null;
}

export interface AuditStore {
  /** Writes the event of a change about to run; `finish` completes it. Returns its id. */
  begin(event: Omit<AuditEvent, "id" | "status" | "occurredAt" | "change">): Promise<string>;
  /**
   * Adds what the request learned about itself to a begun event, before its change runs: a target
   * field the event already names keeps its value.
   */
  describe(
    id: string,
    facts: {
      readonly target: AuditTarget;
      readonly privileged: boolean;
      readonly details: Readonly<Record<string, unknown>> | null;
    },
  ): Promise<void>;
  /** Completes a begun event with the status its request ended with. */
  finish(id: string, status: number): Promise<void>;
  record(input: RecordAuditChange): Promise<void>;
  list(query: AuditQuery): Promise<readonly AuditEvent[]>;
  close(): Promise<void>;
}

/** A resource history retains the complete request envelope and narrows only its change. */
export type AuditEventOf<Kind extends AuditChange["kind"]> = Omit<AuditEvent, "change"> & {
  readonly change: Extract<AuditChange, { readonly kind: Kind }>;
};

export function auditEventsOf<Kind extends AuditChange["kind"]>(
  kind: Kind,
  events: readonly AuditEvent[],
): AuditEventOf<Kind>[] {
  return events.filter((event): event is AuditEventOf<Kind> => event.change?.kind === kind);
}

/** Known target facts keep their first value, in memory or in a SQL update. */
export function mergeAuditTarget<Known, Value>(
  known: Readonly<Record<keyof AuditTarget, Known>>,
  learned: Partial<AuditTarget>,
  keep: (known: Known, learned: string | null) => Value,
): Record<keyof AuditTarget, Value> {
  return {
    automationId: keep(known.automationId, learned.automationId ?? null),
    automationSlug: keep(known.automationSlug, learned.automationSlug ?? null),
    environment: keep(known.environment, learned.environment ?? null),
    projectId: keep(known.projectId, learned.projectId ?? null),
    runId: keep(known.runId, learned.runId ?? null),
  };
}

export const keepAuditValue = (known: string | null, learned: string | null): string | null =>
  known ?? learned;

export const AUDIT_CHANGE_REFUSED =
  "The request audit event is missing, finished or already has a change.";
