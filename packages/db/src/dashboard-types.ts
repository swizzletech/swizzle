import type { StepSite, StepSourceLanguage } from "@swizzle/config";
import type { AccessRefusal, ReadScope, Subject } from "./access.js";
import type { AuditEventOf } from "./audit.js";
import type { ApiCheckReport, ApiContractChange } from "./check-report.js";
import type {
  AutomationCheckStatus,
  CredentialState,
  DeclaredConnectionStatus,
  PlatformRunStatus,
  RunTriggerType,
  StoredArtifactLocator,
  StoredArtifactStorageBackend,
  StoredBuildSnapshot,
  StoredMaintenanceRun,
  StoredNotificationDelivery,
  StoredQueueMetricSample,
  StoredRun,
  StoredRuntimeSnapshot,
} from "./control-plane-types.js";
import type { ProjectRef } from "./project-ref.js";
import type { ApprovalAssignee, ApprovalDecision, RunApproval } from "./run-approval.js";
import type { RunCursor } from "./run-cursor.js";
import type { RunState } from "./run-status.js";
import type { ExplainedPlacement, PlacementTarget, WorkerWarning } from "./workers.js";

export interface DashboardSecretStatus {
  readonly algorithm: string | null;
  readonly createdAt: string | null;
  readonly environment: string;
  readonly keyVersion: string | null;
  readonly name: string;
  readonly state: CredentialState;
  readonly secretVersion: number | null;
  readonly updatedAt: string | null;
}

export interface DashboardTriggerSummary {
  readonly chainOnStatus: string | null;
  readonly chainPayloadMode: string | null;
  readonly chainHiddenSourceCount: number;
  readonly chainSourceAutomationNames: readonly string[];
  readonly chainSourceAutomationSlugs: readonly string[];
  readonly cronIntervalMs: number | null;
  readonly cronSchedule: string | null;
  readonly deploymentId: string;
  readonly environment: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly nextRunAt: string | null;
  readonly pausedAt: string | null;
  readonly status: "active" | "invalid" | "paused";
  readonly triggerId: string;
  readonly triggerType: "chain" | "cron" | "webhook";
  readonly updatedAt: string;
  readonly versionId: string;
  readonly webhookPath: string | null;
}

export interface DashboardDeploymentSummary {
  readonly artifactBackend: StoredArtifactStorageBackend;
  readonly artifactLocator: StoredArtifactLocator;
  readonly artifactRootPath: string;
  readonly buildSnapshot: StoredBuildSnapshot;
  readonly deployedAt: string;
  readonly deploymentId: string;
  readonly entrypoint: string;
  readonly environment: string;
  readonly manifestPath: string;
  readonly runtimeSnapshot: StoredRuntimeSnapshot;
  readonly seq: number;
  readonly sourceDirectory: string;
  readonly sourceHash: string;
  readonly status: string;
  readonly triggerType: "chain" | "cron" | "webhook";
  readonly vars: Record<string, string | number | boolean>;
  readonly version: string;
  readonly versionId: string;
}

export type DashboardRunDetail = StoredRun & {
  readonly state: RunState;
  readonly refusals: {
    readonly cancel: AccessRefusal | null;
    readonly edit: AccessRefusal | null;
    readonly runAgain: AccessRefusal | null;
  };
  readonly placement: ExplainedPlacement | null;
  readonly approval:
    | (RunApproval & { readonly may: { readonly decide: boolean; readonly reassign: boolean } })
    | null;
};

export interface DashboardRunListItem {
  readonly approval: RunApproval | null;
  readonly attemptsMade: number;
  readonly attemptsMax: number;
  readonly automationId: string;
  readonly projectId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly childRunCount: number;
  readonly chainOriginRunId: string | null;
  readonly chainSourceRunIds: readonly string[];
  readonly deadLetterReason: string | null;
  readonly deploymentId: string;
  readonly environment: string;
  readonly errorClassification: "retryable" | "terminal" | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly finishedAt: string | null;
  readonly parentRunId: string | null;
  readonly parentStepKey: string | null;
  readonly queuedAt: string;
  readonly runId: string;
  readonly startedAt: string | null;
  readonly state: RunState;
  readonly status: PlatformRunStatus;
  readonly triggerType: RunTriggerType;
  readonly version: string;
  readonly versionId: string;
  readonly wait: StoredRun["wait"];
}

export interface DashboardQueuedRuns extends PlacementTarget {
  readonly automation: DashboardAutomationRef;
  readonly runId: string;
  readonly queued: number;
  readonly deadline: string;
  readonly queueTimeout: string;
}

export interface DashboardRunGlance {
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly queuedAt: string;
  readonly runId: string;
  readonly state: RunState;
  readonly status: DashboardRunListItem["status"];
  readonly triggerType: RunTriggerType;
}

export interface DashboardConnectionStatus {
  readonly name: string;
  readonly provider: string | null;
  readonly status: DeclaredConnectionStatus;
}

export interface DashboardCheckRecord {
  readonly consecutiveFailures: number;
  readonly deploymentId: string;
  readonly failingSince: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastExitCode: number | null;
  readonly lastGreenAt: string | null;
  readonly lastGreenOutput: string | null;
  readonly lastGreenReport: ApiCheckReport | null;
  readonly lastReport: ApiCheckReport | null;
  readonly lastOutput: string | null;
  readonly lastStderrTail: string | null;
  readonly lastWarning: string | null;
  readonly nextCheckAt: string;
  readonly status: AutomationCheckStatus;
}

export type DashboardApiCheck =
  | {
      readonly mode: "active";
      readonly entrypoint: string;
      readonly everyMs: number;
      readonly record: DashboardCheckRecord | null;
      readonly secrets: readonly string[] | null;
    }
  | {
      readonly mode: "passive";
      readonly untestedAfterMs: number;
    }
  | { readonly mode: "off"; readonly reason: string };

export interface DashboardApiContact {
  readonly deprecatedAt: string | null;
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

export interface DashboardAutomationSummary {
  readonly activeDeployment: DashboardDeploymentSummary;
  readonly apiCheck: DashboardApiCheck | null;
  readonly apiContacts: readonly DashboardApiContact[];
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly description: string | null;
  readonly environment: string;
  readonly folderId: string | null;
  readonly folderName: string | null;
  readonly invokesAutomationSlugs: readonly string[];
  readonly lastRun: DashboardRunListItem | null;
  readonly projectId: string;
  readonly project: ProjectRef;
  readonly recentRuns: readonly DashboardRunGlance[];
  readonly requiredConnections: readonly DashboardConnectionStatus[];
  readonly requiredSecrets: readonly DashboardSecretStatus[];
  readonly trigger: DashboardTriggerSummary | null;
}

export interface DashboardAutomationRefusals {
  readonly run: AccessRefusal | null;
  readonly edit: AccessRefusal | null;
  readonly organize: AccessRefusal | null;
}

export interface DashboardAutomationDetail extends DashboardAutomationSummary {
  readonly deploymentAudit: readonly AuditEventOf<"deployment">[];
  readonly deploymentHistory: readonly DashboardDeploymentSummary[];
}

export interface DashboardDeploymentChange extends AuditEventOf<"deployment"> {
  readonly automationName: string;
  readonly automationSlug: string;
}

export interface DashboardAutomationRef {
  readonly automationName: string;
  readonly automationSlug: string;
}

export type DashboardAttentionItem =
  | {
      readonly kind: "approval";
      readonly automation: DashboardAutomationRef;
      readonly assignee: ApprovalAssignee | null;
      readonly details: unknown;
      readonly runId: string;
      readonly stepKey: string;
      readonly waitingSince: string;
      readonly waitUntil: string | null;
    }
  | {
      readonly kind: "failing";
      readonly automation: DashboardAutomationRef;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
      readonly failedRuns: number;
      readonly lastFailedAt: string;
      readonly lastFailedRunId: string;
      readonly lastFailedTriggerType: RunTriggerType;
      readonly recentRuns: number;
    }
  | {
      readonly kind: "missing-secret";
      readonly project: ProjectRef;
      readonly secretName: string;
      readonly state: Exclude<CredentialState, "bound">;
      readonly usedBy: readonly DashboardAutomationRef[];
    }
  | {
      readonly kind: "missing-connection";
      readonly connectionName: string;
      readonly project: ProjectRef;
      readonly provider: string | null;
      readonly status: Exclude<DashboardConnectionStatus["status"], "active">;
      readonly usedBy: readonly DashboardAutomationRef[];
    }
  | {
      readonly kind: "trigger-invalid";
      readonly automation: DashboardAutomationRef;
      readonly message: string | null;
    }
  | {
      readonly kind: "api-check";
      readonly automation: DashboardAutomationRef;
      readonly change: ApiContractChange | null;
      readonly check: DashboardCheckRecord & {
        readonly entrypoint: string;
        readonly everyMs: number;
      };
      readonly latestRun: {
        readonly queuedAt: string;
        readonly status: DashboardRunGlance["status"];
      } | null;
    }
  | {
      readonly kind: "api-sunset";
      readonly apiCheck: DashboardApiCheck | null;
      readonly automation: DashboardAutomationRef;
      readonly contact: DashboardApiContact;
    }
  | {
      readonly kind: "api-untested";
      readonly automation: DashboardAutomationRef;
      readonly host: string | null;
      readonly since: string;
      readonly thresholdMs: number;
    }
  | {
      readonly kind: "waiting-for-worker";
      readonly automation: DashboardAutomationRef;
      readonly runId: string;
      readonly queuedRuns: number;
      readonly group: string;
      readonly deadline: string;
      readonly reason: string;
    }
  | { readonly kind: "platform"; readonly problem: DashboardPlatformProblem }
  | {
      readonly kind: "notifications-failed";
      readonly failed: number;
      readonly lastError: string | null;
      readonly lastFailedAt: string;
    };

export type DashboardPlatformProblem =
  | { readonly code: "no-worker"; readonly queuedRuns: number }
  | {
      readonly code: "scheduler-down";
      readonly environment: string;
      readonly served: readonly string[];
    }
  | { readonly code: "queue-unreachable" }
  | { readonly code: "queue-backlog"; readonly waitingJobs: number }
  | { readonly code: "maintenance-failing"; readonly lastRunAt: string }
  | {
      readonly code: "run-image-disk";
      readonly worker: string;
      readonly warning: WorkerWarning;
    };

export type DashboardHourCounts = Readonly<Partial<Record<RunState, number>>>;

export interface TimetableClock {
  readonly now: Date;
  readonly utcOffsetMinutes: number;
}

export interface TimetableWindow {
  readonly from: Date;
  readonly until: Date;
}

export interface DashboardTimetableRow {
  readonly automationSlug: string;
  readonly hours: readonly DashboardHourCounts[];
  readonly deployments: readonly { readonly at: string; readonly version: string }[];
}

export interface DashboardTimetable {
  readonly from: string;
  readonly rows: readonly DashboardTimetableRow[];
}

export interface DashboardOverview {
  readonly environment: string;
  readonly last24h: Readonly<Record<RunState, number>>;
  readonly last24hFrom: string;
  readonly lastFailureAt: string | null;
  readonly needsYou: readonly DashboardAttentionItem[];
  readonly complete: boolean;
  readonly recentChanges: readonly DashboardDeploymentChange[];
  readonly timetable: DashboardTimetable;
}

export interface DashboardRunsQuery {
  readonly approvalOnly?: boolean;
  readonly assignedTo?: readonly Subject[];
  readonly automationSlug?: string;
  readonly cursor?: RunCursor;
  readonly environment: string;
  readonly failedOnly?: boolean;
  readonly limit?: number;
  readonly parentRunId?: string;
  readonly queuedSince?: Date;
  readonly scope: ReadScope;
  readonly states?: readonly RunState[];
  readonly statuses?: readonly DashboardRunListItem["status"][];
  readonly topLevelOnly?: boolean;
  readonly triggerType?: DashboardRunListItem["triggerType"];
}

export interface DashboardRunsResult {
  readonly environment: string;
  readonly filters: {
    readonly automationSlug: string | null;
    readonly limit: number;
    readonly states: readonly RunState[];
    readonly statuses: readonly DashboardRunListItem["status"][];
    readonly triggerType: DashboardRunListItem["triggerType"] | null;
  };
  readonly nextCursor: string | null;
  readonly runs: readonly DashboardRunListItem[];
}

export interface DashboardArtifactDocument {
  readonly automationSlug: string;
  readonly available: boolean;
  readonly content: string | null;
  readonly environment: string;
  readonly error: string | null;
  readonly filePath: string | null;
}

export type DashboardAutomationReadme = DashboardArtifactDocument;
export type DashboardMermaidDiagram = DashboardArtifactDocument;

export interface DashboardAutomationSource {
  readonly automationSlug: string;
  readonly deploymentId: string;
  readonly entrypoint: string;
  readonly language: StepSourceLanguage;
  readonly content: string | null;
  readonly error: string | null;
  readonly steps: readonly StepSite[];
}

export interface DashboardStepReach {
  readonly runs: number;
  readonly reached: Readonly<Record<string, number>>;
}

export interface DashboardObservedInvocation {
  readonly childSlug: string;
  readonly parentSlug: string;
}

export interface DashboardRunStep {
  readonly approval: ApprovalDecision | null;
  readonly attempt: number;
  readonly executionNumber: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly startedAt: string | null;
  readonly stepKey: string;
  readonly updatedAt: string;
  readonly value: unknown;
}

export interface ServiceHeartbeatRecord {
  readonly createdAt: string;
  readonly environment: string;
  readonly host: string | null;
  readonly instanceId: string;
  readonly metadata: Record<string, unknown>;
  readonly observedAt: string;
  readonly pid: number | null;
  readonly service: string;
  readonly updatedAt: string;
}

export interface UpsertServiceHeartbeatInput {
  readonly environment: string;
  readonly host?: string | null;
  readonly instanceId: string;
  readonly metadata?: Record<string, unknown>;
  readonly observedAt?: string;
  readonly pid?: number | null;
  readonly service: string;
}

export interface DashboardStore {
  close(): Promise<void>;
  getAutomationDetail(
    automationSlug: string,
    environment: string,
    scope: ReadScope,
  ): Promise<DashboardAutomationDetail | null>;
  getMermaidDiagram(
    automationSlug: string,
    environment: string,
  ): Promise<DashboardMermaidDiagram | null>;
  listAutomationSummaries(
    environment: string,
    scope: ReadScope,
  ): Promise<readonly DashboardAutomationSummary[]>;
  listDeploymentChanges(
    environment: string,
    since: Date,
    limit: number,
    scope: ReadScope,
  ): Promise<readonly DashboardDeploymentChange[]>;
  getTimetable(
    environment: string,
    window: TimetableWindow,
    scope: ReadScope,
  ): Promise<DashboardTimetable>;
  listRuns(query: DashboardRunsQuery): Promise<DashboardRunsResult>;
  listQueuedRuns(environment: string, scope: ReadScope): Promise<readonly DashboardQueuedRuns[]>;
  listRunSteps(runId: string): Promise<readonly DashboardRunStep[]>;
  countStepReach(
    automationSlug: string,
    environment: string,
    limit: number,
  ): Promise<DashboardStepReach>;
  listServiceHeartbeats(
    environment: string | null,
    service?: string,
  ): Promise<readonly ServiceHeartbeatRecord[]>;
  upsertServiceHeartbeat(input: UpsertServiceHeartbeatInput): Promise<ServiceHeartbeatRecord>;
}

export interface DashboardQueueSummary {
  readonly counts: {
    readonly active: number;
    readonly completed: number;
    readonly delayed: number;
    readonly failed: number;
    readonly waiting: number;
  };
  readonly name: string;
  readonly queues: readonly {
    readonly counts: DashboardQueueSummary["counts"];
    readonly name: string;
  }[];
}

export interface DashboardServiceHeartbeatView extends ServiceHeartbeatRecord {
  readonly state: "alive" | "stale";
}

export interface DashboardOperabilitySummary {
  readonly automationCount: number;
  readonly environment: string;
  readonly observedAt: string;
  readonly queue: DashboardQueueSummary;
  readonly runStatusCounts: Record<DashboardRunListItem["status"], number>;
  readonly services: {
    readonly heartbeatTtlMs: number;
    readonly instances: readonly DashboardServiceHeartbeatView[];
    readonly summary: readonly {
      readonly alive: number;
      readonly service: string;
      readonly stale: number;
      readonly total: number;
    }[];
  };
  readonly triggerStatusCounts: Record<"active" | "invalid" | "paused" | "missing", number>;
}

export interface DashboardOperationsSummary extends DashboardOperabilitySummary {
  readonly onlineWorkers: number;
  readonly maintenance: {
    readonly latestRun: StoredMaintenanceRun | null;
    readonly staleAfterMs: number;
    readonly state: "healthy" | "degraded" | "missing";
  };
  readonly notifications: {
    readonly deliveries: readonly StoredNotificationDelivery[];
    readonly failed: number;
    readonly sent: number;
    readonly skipped: number;
  };
  readonly queue: DashboardQueueSummary & {
    readonly recentSamples: readonly StoredQueueMetricSample[];
  };
  readonly state: "healthy" | "degraded";
  readonly stateReasons: readonly string[];
}
