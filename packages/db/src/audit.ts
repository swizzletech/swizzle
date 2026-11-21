import type { AutomationConfig, AutomationRuntimeConfig } from "@swizzle/config";
import type { AuditActor } from "./audit-actor.js";

export type { AuditActor } from "./audit-actor.js";

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
  | "cron_missed"
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
      readonly projectId: string;
      readonly runId: string | null;
      readonly triggerId: string;
      readonly triggerType: AutomationConfig["trigger"]["type"];
    }
  | {
      readonly kind: "deployment";
      readonly automationId: string;
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
  readonly action: string;
  readonly params: Readonly<Record<string, string>>;
  readonly target: AuditTarget;
  readonly privileged: boolean;
  readonly status: number | null;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly requestId: string;
}

export interface AuditQuery {
  readonly projectIds: readonly string[] | null;
  readonly environments: readonly string[] | null;
  readonly automation?: string;
  readonly actorId?: string;
  readonly kind?: AuditChange["kind"];
  readonly workerId?: string;
  readonly order?: "newest" | "oldest";
  readonly before?: string;
  readonly limit: number | null;
}

export interface AuditStore {
  begin(event: Omit<AuditEvent, "id" | "status" | "occurredAt" | "change">): Promise<string>;
  describe(
    id: string,
    facts: {
      readonly target: AuditTarget;
      readonly privileged: boolean;
      readonly details: Readonly<Record<string, unknown>> | null;
    },
  ): Promise<void>;
  finish(id: string, status: number): Promise<void>;
  record(input: RecordAuditChange): Promise<void>;
  list(query: AuditQuery): Promise<readonly AuditEvent[]>;
  close(): Promise<void>;
}

export type AuditEventOf<Kind extends AuditChange["kind"]> = Omit<AuditEvent, "change"> & {
  readonly change: Extract<AuditChange, { readonly kind: Kind }>;
};

export function auditEventsOf<Kind extends AuditChange["kind"]>(
  kind: Kind,
  events: readonly AuditEvent[],
): AuditEventOf<Kind>[] {
  return events.filter((event): event is AuditEventOf<Kind> => event.change?.kind === kind);
}

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
