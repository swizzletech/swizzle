import type { ReadScope } from "../access.js";
import type { ApiCheckReport } from "../check-report.js";
import type {
  MaintenanceRunStatus,
  NotificationChannel,
  NotificationDeliveryEventType,
  NotificationDeliveryStatus,
  NotificationEventType,
} from "./common.js";
import type { StoredConnectionUsage, StoredSecretUsage } from "./credentials.js";

/**
 * A person's subscription to the failures of one automation, or with null automation fields of
 * every automation of a project, in one environment. It sends only while the person may read the
 * failed run (`personMayRead`), so a revoked grant stops it.
 */
export interface StoredNotificationRule {
  readonly userId: string;
  readonly projectId: string;
  readonly automationId: string | null;
  readonly automationName: string | null;
  readonly automationSlug: string | null;
  readonly channel: NotificationChannel;
  readonly chatId: string;
  readonly cooldownSeconds: number;
  readonly createdAt: string;
  readonly enabled: boolean;
  readonly environment: string;
  readonly eventType: NotificationEventType;
  readonly ruleId: string;
  readonly threshold: number;
  readonly updatedAt: string;
  readonly windowSeconds: number;
}

export interface CreateNotificationRuleInput {
  readonly userId: string;
  readonly projectId: string;
  /** Null for a rule that covers every automation of the project. */
  readonly automationId: string | null;
  readonly channel: NotificationChannel;
  readonly chatId: string;
  readonly cooldownSeconds: number;
  readonly enabled?: boolean;
  readonly environment: string;
  readonly eventType: NotificationEventType;
  readonly threshold: number;
  readonly windowSeconds: number;
}

export interface UpdateNotificationRuleInput {
  readonly chatId?: string;
  readonly cooldownSeconds?: number;
  readonly enabled?: boolean;
  readonly ruleId: string;
  readonly threshold?: number;
  readonly updatedAt: string;
  readonly windowSeconds?: number;
}

export interface ListNotificationRulesQuery {
  /** Rules for this automation in this project, including the rules that cover the project. */
  readonly automation?: { readonly automationId: string; readonly projectId: string };
  /** Only this person's rules. */
  readonly userId?: string;
  readonly environment: string;
  readonly eventType?: NotificationEventType;
}

export interface StoredNotificationDelivery {
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly channel: NotificationChannel;
  readonly chatId: string;
  readonly createdAt: string;
  readonly dedupeKey: string;
  readonly deliveredAt: string | null;
  readonly deliveryId: string;
  readonly environment: string;
  readonly errorMessage: string | null;
  readonly eventType: NotificationDeliveryEventType;
  readonly metadata: Record<string, unknown>;
  readonly providerMessageId: string | null;
  readonly ruleId: string | null;
  readonly runId: string | null;
  readonly status: NotificationDeliveryStatus;
  readonly updatedAt: string;
}

export interface CreateNotificationDeliveryInput {
  readonly automationId: string;
  readonly channel: NotificationChannel;
  readonly chatId: string;
  readonly dedupeKey: string;
  readonly deliveredAt?: string | null;
  readonly environment: string;
  readonly errorMessage?: string | null;
  readonly eventType: NotificationDeliveryEventType;
  readonly metadata?: Record<string, unknown>;
  readonly providerMessageId?: string | null;
  readonly ruleId?: string | null;
  readonly runId?: string | null;
  readonly status: NotificationDeliveryStatus;
  readonly updatedAt?: string;
}

export interface NotificationDeliveryUpsertResult {
  readonly created: boolean;
  readonly delivery: StoredNotificationDelivery;
}

export interface UpdateNotificationDeliveryInput {
  readonly deliveredAt?: string | null;
  readonly deliveryId: string;
  readonly errorMessage?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly providerMessageId?: string | null;
  readonly status: NotificationDeliveryStatus;
  readonly updatedAt: string;
}

export interface ListNotificationDeliveriesQuery {
  readonly automationId?: string;
  readonly automationSlug?: string;
  /** Only deliveries created at or after this ISO time. */
  readonly createdSince?: string;
  readonly environment: string;
  readonly eventType?: NotificationDeliveryEventType;
  readonly limit?: number;
  readonly ruleId?: string;
  /**
   * Only deliveries of the rules this person made, for automations they still read: a rule
   * outlives the grant it was made under.
   */
  readonly ruleOwner?: { readonly userId: string; readonly scope: ReadScope };
  readonly status?: NotificationDeliveryStatus;
}

export interface StoredQueueMetricSample {
  readonly counts: {
    readonly active: number;
    readonly completed: number;
    readonly delayed: number;
    readonly failed: number;
    readonly waiting: number;
  };
  readonly environment: string;
  readonly observedAt: string;
  readonly queueName: string;
  readonly sampleId: string;
}

export interface CreateQueueMetricSampleInput {
  readonly counts: StoredQueueMetricSample["counts"];
  readonly environment: string;
  readonly observedAt: string;
  readonly queueName: string;
}

export interface ListQueueMetricSamplesQuery {
  readonly environment: string;
  readonly limit?: number;
  readonly queueName?: string;
}

export interface StoredMaintenanceRun {
  readonly createdAt: string;
  readonly environment: string;
  readonly errorMessage: string | null;
  readonly finishedAt: string | null;
  readonly maintenanceRunId: string;
  readonly startedAt: string;
  readonly status: MaintenanceRunStatus;
  readonly summary: Record<string, unknown>;
}

export interface CreateMaintenanceRunInput {
  readonly environment: string;
  readonly errorMessage?: string | null;
  readonly finishedAt?: string | null;
  readonly startedAt: string;
  readonly status: MaintenanceRunStatus;
  readonly summary?: Record<string, unknown>;
}

export interface CleanupMaintenanceInput {
  readonly deliveryCutoff: string;
  readonly environment: string;
  readonly heartbeatCutoff: string;
  readonly metricsCutoff: string;
}

export interface CleanupMaintenanceResult {
  readonly deletedDeliveries: number;
  readonly deletedHeartbeats: number;
  readonly deletedMetricSamples: number;
}

export interface ExpireRunsInput {
  readonly environment: string;
  /** Finished runs whose finished_at is at or before this instant expire. */
  readonly cutoff: string;
}

export interface ExpireRunsResult {
  /** Deleted runs; their attempts, logs, steps and usages went with them. */
  readonly runsDeleted: number;
}

/**
 * Where an automation's API check stands. `pending` until the first check of a deployment ran;
 * `drift` when the check reached the API and the answer differs; `credentials` when its login
 * failed; `error` when it could not decide (another exit, a signal, a timeout, invalid stdout).
 */
export type AutomationCheckStatus = "pending" | "green" | "drift" | "credentials" | "error";

/** The one `automation_checks` row of an automation with `api_check.mode: active` in an environment. */
export interface StoredAutomationCheck {
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly checkId: string;
  readonly consecutiveFailures: number;
  readonly deploymentId: string;
  /** The check script, relative to the automation folder. */
  readonly entrypoint: string;
  readonly environment: string;
  readonly everyMs: number;
  /** When the current run of failures began; null while green or pending. */
  readonly failingSince: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastExitCode: number | null;
  readonly lastGreenAt: string | null;
  readonly lastGreenOutput: string | null;
  readonly lastGreenReport: ApiCheckReport | null;
  readonly lastReport: ApiCheckReport | null;
  /** The latest check's stdout, redacted. */
  readonly lastOutput: string | null;
  /** The connection tokens the latest check received; empty when it failed before receiving any. */
  readonly lastConnectionUsages: readonly StoredConnectionUsage[];
  /** The secrets the latest check received; empty when it failed before receiving any. */
  readonly lastSecretUsages: readonly StoredSecretUsage[];
  readonly lastStderrTail: string | null;
  /** What the platform ignored in the latest check, such as state writes. */
  readonly lastWarning: string | null;
  /** The due time and claim cursor: the scheduler enqueues the check once it has passed. */
  readonly nextCheckAt: string;
  /** The worker profile whose queue runs the check, the automation's `runtime.profile`. */
  readonly profile: string;
  readonly status: AutomationCheckStatus;
  readonly versionId: string;
}

/** The outcome of one check, written only while `dueAt` still is the row's `nextCheckAt`. */
export interface CompleteAutomationCheckInput {
  readonly checkedAt: string;
  readonly checkId: string;
  readonly connectionUsages: readonly StoredConnectionUsage[];
  readonly consecutiveFailures: number;
  readonly dueAt: string;
  readonly exitCode: number | null;
  readonly failingSince: string | null;
  readonly nextCheckAt: string;
  readonly output: string | null;
  readonly report: ApiCheckReport;
  readonly secretUsages: readonly StoredSecretUsage[];
  readonly status: Exclude<AutomationCheckStatus, "pending">;
  readonly stderrTail: string | null;
  readonly warning: string | null;
}

/** A retirement notice an API sent with a response: the Deprecation, Sunset and Link headers. */
export interface ApiNoticeObservation {
  readonly deprecatedAt: string | null;
  /** The first redacted path, without query, that carried the notice. */
  readonly path: string | null;
  readonly sunsetAt: string | null;
  /** The Link target with `rel="deprecation"` or `rel="sunset"`. */
  readonly url: string | null;
}

/** What one attempt saw of one API host through the SDK's HTTP helper. */
export interface ApiContactObservation {
  readonly host: string;
  readonly lastContactAt: string;
  readonly lastOkAt: string | null;
  readonly lastStatus: number;
  readonly notice: ApiNoticeObservation | null;
}

export interface RecordApiContactsInput {
  readonly automationId: string;
  readonly contacts: readonly ApiContactObservation[];
  readonly environment: string;
}

/** The `api_contacts` row of one automation, environment and host. */
export interface StoredApiContact {
  readonly automationId: string;
  readonly deprecatedAt: string | null;
  readonly environment: string;
  readonly host: string;
  readonly lastContactAt: string;
  readonly lastOkAt: string | null;
  readonly lastStatus: number;
  readonly noticePath: string | null;
  /** How many attempts saw a notice from this host. */
  readonly noticeRuns: number;
  readonly noticeSeenAt: string | null;
  readonly noticeUrl: string | null;
  readonly sunsetAt: string | null;
}

/** An automation and the project that owns it, in every environment. */
export interface AutomationOwner {
  readonly automationId: string;
  readonly automationSlug: string;
  readonly projectId: string;
}

/** The automation after a move; `moved` is false when it was in the project already. */
export interface MovedAutomation extends AutomationOwner {
  readonly moved: boolean;
}
