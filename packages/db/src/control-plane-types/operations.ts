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
  readonly automation?: { readonly automationId: string; readonly projectId: string };
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
  readonly createdSince?: string;
  readonly environment: string;
  readonly eventType?: NotificationDeliveryEventType;
  readonly limit?: number;
  readonly ruleId?: string;
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
  readonly cutoff: string;
}

export interface ExpireRunsResult {
  readonly runsDeleted: number;
}

export type AutomationCheckStatus = "pending" | "green" | "drift" | "credentials" | "error";

export interface StoredAutomationCheck {
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly checkId: string;
  readonly consecutiveFailures: number;
  readonly deploymentId: string;
  readonly entrypoint: string;
  readonly environment: string;
  readonly everyMs: number;
  readonly failingSince: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastExitCode: number | null;
  readonly lastGreenAt: string | null;
  readonly lastGreenOutput: string | null;
  readonly lastGreenReport: ApiCheckReport | null;
  readonly lastReport: ApiCheckReport | null;
  readonly lastOutput: string | null;
  readonly lastConnectionUsages: readonly StoredConnectionUsage[];
  readonly lastSecretUsages: readonly StoredSecretUsage[];
  readonly lastStderrTail: string | null;
  readonly lastWarning: string | null;
  readonly nextCheckAt: string;
  readonly profile: string;
  readonly status: AutomationCheckStatus;
  readonly versionId: string;
}

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

export interface ApiNoticeObservation {
  readonly deprecatedAt: string | null;
  readonly path: string | null;
  readonly sunsetAt: string | null;
  readonly url: string | null;
}

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

export interface StoredApiContact {
  readonly automationId: string;
  readonly deprecatedAt: string | null;
  readonly environment: string;
  readonly host: string;
  readonly lastContactAt: string;
  readonly lastOkAt: string | null;
  readonly lastStatus: number;
  readonly noticePath: string | null;
  readonly noticeRuns: number;
  readonly noticeSeenAt: string | null;
  readonly noticeUrl: string | null;
  readonly sunsetAt: string | null;
}

export interface AutomationOwner {
  readonly automationId: string;
  readonly automationSlug: string;
  readonly projectId: string;
}

export interface MovedAutomation extends AutomationOwner {
  readonly moved: boolean;
}
