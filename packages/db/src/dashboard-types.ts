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
import type { ExplainedPlacement, PlacementTarget, WorkerWarning } from "./workers.js";

/** A secret an automation declares; the stored fields describe the bound secret. */
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
  /**
   * The chain sources the reader may read: in chain order, one for a single source and every one
   * of a join. A source in a project the reader cannot read is only counted.
   */
  readonly chainHiddenSourceCount: number;
  readonly chainSourceAutomationNames: readonly string[];
  /** Slugs paired 1:1 with `chainSourceAutomationNames`, stable ids for grouping. */
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

/** A run as its panel shows it, with its open approval and what the viewer may do with it. */
export type DashboardRunDetail = StoredRun & {
  /**
   * Why the viewer may not cancel the run, decided where the run belongs, or start its automation
   * again or hand it to an agent who changes and deploys it, decided where the automation is now;
   * null when they may.
   */
  readonly refusals: {
    readonly cancel: AccessRefusal | null;
    readonly edit: AccessRefusal | null;
    readonly runAgain: AccessRefusal | null;
  };
  /** Why a queued run waits for a worker and until when; null unless it is queued. */
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
  /** The project the run started in, which stays its own after the automation moves. */
  readonly projectId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly childRunCount: number;
  /** The run a chain run correlates under: its source, or for a join the origin of its sources. */
  readonly chainOriginRunId: string | null;
  /** The source runs whose success started this chain run: one, or every source of a join. */
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
  readonly status: PlatformRunStatus;
  readonly triggerType: RunTriggerType;
  readonly version: string;
  readonly versionId: string;
  /** The step the run waits at, whatever it waits for; the track lights that station. */
  readonly wait: StoredRun["wait"];
}

/** Queued runs that share what placement reads of them; see `listQueuedRuns`. */
export interface DashboardQueuedRuns extends PlacementTarget {
  readonly automation: DashboardAutomationRef;
  /** The oldest of them. */
  readonly runId: string;
  readonly queued: number;
  /** The earliest time one of them fails if no worker takes it. */
  readonly deadline: string;
  readonly queueTimeout: string;
}

/** One run in an automation's health strip. */
export interface DashboardRunGlance {
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly queuedAt: string;
  readonly runId: string;
  readonly status: DashboardRunListItem["status"];
  readonly triggerType: RunTriggerType;
}

/** A connection an automation declares in config.yaml, with the state of the bound account. */
export interface DashboardConnectionStatus {
  readonly name: string;
  /** The bound account's provider, null while the deployment holds none. */
  readonly provider: string | null;
  readonly status: DeclaredConnectionStatus;
}

/** The latest check of an active `api_check`, as the About tab and Needs you show it. */
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

/** An automation's `api_check` level; null on the summary while it reaches no outside API. */
export type DashboardApiCheck =
  | {
      readonly mode: "active";
      readonly entrypoint: string;
      readonly everyMs: number;
      /** Null until the deploy wrote the record. */
      readonly record: DashboardCheckRecord | null;
      /** The subset of secrets the check receives; null means all of them. */
      readonly secrets: readonly string[] | null;
    }
  | {
      readonly mode: "passive";
      /** `untested_after`, or twice the cron interval when that is longer. */
      readonly untestedAfterMs: number;
    }
  | { readonly mode: "off"; readonly reason: string };

/** What the automation's runs and checks saw of one API host. */
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
  /** One per host the SDK's HTTP helper reached, most recent contact first. */
  readonly apiContacts: readonly DashboardApiContact[];
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly description: string | null;
  readonly environment: string;
  readonly folderId: string | null;
  readonly folderName: string | null;
  /**
   * Automations this one starts with `invokeAutomation`, for the pipeline graph's invoke lanes:
   * the targets its deployed entrypoint names (the API adds them) and those its runs started in
   * the last 7 days (the store adds them), sorted and distinct.
   */
  readonly invokesAutomationSlugs: readonly string[];
  readonly lastRun: DashboardRunListItem | null;
  /** The project that owns the automation, and so its secrets. */
  readonly projectId: string;
  readonly project: ProjectRef;
  /** The last 10 top-level runs, newest first. */
  readonly recentRuns: readonly DashboardRunGlance[];
  readonly requiredConnections: readonly DashboardConnectionStatus[];
  readonly requiredSecrets: readonly DashboardSecretStatus[];
  readonly trigger: DashboardTriggerSummary | null;
}

/**
 * What the viewer may not do with an automation they read, and why; null where they may. The
 * API adds it to the automation's detail, and its page leaves out each refused control.
 */
export interface DashboardAutomationRefusals {
  /** Run now. */
  readonly run: AccessRefusal | null;
  /** Pause, Resume and Roll back. */
  readonly edit: AccessRefusal | null;
  /** Move to folder. */
  readonly organize: AccessRefusal | null;
}

export interface DashboardAutomationDetail extends DashboardAutomationSummary {
  readonly deploymentAudit: readonly AuditEventOf<"deployment">[];
  readonly deploymentHistory: readonly DashboardDeploymentSummary[];
}

/** A deploy or rollback of any automation in the environment, for the Overview's Recently changed. */
export interface DashboardDeploymentChange extends AuditEventOf<"deployment"> {
  readonly automationName: string;
  readonly automationSlug: string;
}

export interface DashboardAutomationRef {
  readonly automationName: string;
  readonly automationSlug: string;
}

/**
 * Something the owner has to act on, as the Overview's "Needs you" lists it. The API names the
 * kind and the facts; the dashboard words them, so no internal code reaches the owner. Words about
 * workers come worded from the runtime (`reason`, `warning`), because the CLI prints them too.
 */
export type DashboardAttentionItem =
  | {
      readonly kind: "approval";
      readonly automation: DashboardAutomationRef;
      /** The person or team who decides; null when whoever may run the automation decides. */
      readonly assignee: ApprovalAssignee | null;
      /** What the automation passed with the approval request, shown to who decides. */
      readonly details: unknown;
      readonly runId: string;
      readonly stepKey: string;
      readonly waitingSince: string;
      readonly waitUntil: string | null;
    }
  | {
      readonly kind: "failing";
      readonly automation: DashboardAutomationRef;
      /** `UPSTREAM_CONTRACT_CHANGED` names an API change rather than a fault in the code. */
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
      readonly failedRuns: number;
      readonly lastFailedAt: string;
      readonly lastFailedRunId: string;
      /** How the latest failed run started: a chain run cannot be replayed, a webhook one loses its signed delivery. */
      readonly lastFailedTriggerType: RunTriggerType;
      /** How many recent runs `failedRuns` counts from. */
      readonly recentRuns: number;
    }
  | {
      readonly kind: "missing-secret";
      /** The project whose secret is missing: each project holds its own. */
      readonly project: ProjectRef;
      readonly secretName: string;
      readonly state: Exclude<CredentialState, "bound">;
      readonly usedBy: readonly DashboardAutomationRef[];
    }
  | {
      readonly kind: "missing-connection";
      readonly connectionName: string;
      /** The project whose automations need the account: each project holds its own. */
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
      /** An active API check that shows drift, or could not decide 3 times in a row. */
      readonly kind: "api-check";
      readonly automation: DashboardAutomationRef;
      /** What the drift output names, when the check reported it. */
      readonly change: ApiContractChange | null;
      readonly check: DashboardCheckRecord & {
        readonly entrypoint: string;
        readonly everyMs: number;
      };
      /** The automation's latest finished run, to tell whether the change reached its runs yet. */
      readonly latestRun: {
        readonly queuedAt: string;
        readonly status: DashboardRunGlance["status"];
      } | null;
    }
  | {
      /** An API the automation calls announced its retirement through Deprecation or Sunset. */
      readonly kind: "api-sunset";
      readonly apiCheck: DashboardApiCheck | null;
      readonly automation: DashboardAutomationRef;
      readonly contact: DashboardApiContact;
    }
  | {
      /** A passive automation that has not reached an API for longer than its threshold. */
      readonly kind: "api-untested";
      readonly automation: DashboardAutomationRef;
      /** Null when no call went through the SDK's HTTP helper since the deploy. */
      readonly host: string | null;
      /** The last contact, or the deploy when there was none. */
      readonly since: string;
      readonly thresholdMs: number;
    }
  | {
      /**
       * Queued runs no worker can take until an instance owner or admin acts; see `UNPLACED` in
       * dashboard-attention.ts. Only they see it.
       */
      readonly kind: "waiting-for-worker";
      readonly automation: DashboardAutomationRef;
      /** The oldest of the runs. */
      readonly runId: string;
      readonly queuedRuns: number;
      readonly group: string;
      /** When the oldest fails if no worker takes it. */
      readonly deadline: string;
      /** Why, in the runtime's words that `swizzle diagnose` and the run panel print. */
      readonly reason: string;
    }
  | { readonly kind: "platform"; readonly problem: DashboardPlatformProblem }
  | {
      readonly kind: "notifications-failed";
      readonly failed: number;
      readonly lastError: string | null;
      readonly lastFailedAt: string;
    };

/** A platform fault the owner can see the effect of. A fresh instance whose maintenance never ran has none. */
export type DashboardPlatformProblem =
  | { readonly code: "no-worker"; readonly queuedRuns: number }
  | {
      readonly code: "scheduler-down";
      /** The environment no live scheduler serves. */
      readonly environment: string;
      /** The environments a live scheduler serves instead. */
      readonly served: readonly string[];
    }
  | { readonly code: "queue-unreachable" }
  | { readonly code: "queue-backlog"; readonly waitingJobs: number }
  | { readonly code: "maintenance-failing"; readonly lastRunAt: string }
  | {
      readonly code: "run-image-disk";
      readonly worker: string;
      /** The runtime's words, as Settings > Workers and `swizzle worker list` print them. */
      readonly warning: WorkerWarning;
    };

/** The Overview's read model: the status sentence, Needs you and Recently changed. */
export interface DashboardOverview {
  readonly environment: string;
  /** Top-level runs queued in the last 24 hours, by status. */
  readonly last24h: Readonly<Record<DashboardRunListItem["status"], number>>;
  readonly needsYou: readonly DashboardAttentionItem[];
  /**
   * Whether Needs you lists everything: the viewer may edit every automation in view and acts on
   * the instance as its owner or admin. When not, it leaves out what they cannot act on, so its
   * empty state says only that nothing needs them.
   */
  readonly complete: boolean;
  /** Deploys and rollbacks of the last 7 days, newest first. */
  readonly recentChanges: readonly DashboardDeploymentChange[];
}

export interface DashboardRunsQuery {
  /** Only runs whose current wait is an approval. */
  readonly approvalOnly?: boolean;
  /** Only approvals assigned to nobody or to one of these people and teams; absent for any. */
  readonly assignedTo?: readonly Subject[];
  readonly automationSlug?: string;
  readonly environment: string;
  readonly limit?: number;
  readonly parentRunId?: string;
  /** The automations whose runs the list may show. */
  readonly scope: ReadScope;
  /** Runs in any of these states; empty or absent means every state. */
  readonly statuses?: readonly DashboardRunListItem["status"][];
  readonly topLevelOnly?: boolean;
  readonly triggerType?: DashboardRunListItem["triggerType"];
}

export interface DashboardRunsResult {
  readonly environment: string;
  readonly filters: {
    readonly automationSlug: string | null;
    readonly limit: number;
    readonly statuses: readonly DashboardRunListItem["status"][];
    readonly triggerType: DashboardRunListItem["triggerType"] | null;
  };
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

/** One deployment's entrypoint and the step call sites in it, for Automation Play and drift. */
export interface DashboardAutomationSource {
  readonly automationSlug: string;
  readonly deploymentId: string;
  /** The entrypoint path as config.yaml names it. */
  readonly entrypoint: string;
  readonly language: StepSourceLanguage;
  /** Null when the file could not be read; `error` then says why. */
  readonly content: string | null;
  readonly error: string | null;
  readonly steps: readonly StepSite[];
}

/** How many of an automation's last runs reached each step, for the track without a run. */
export interface DashboardStepReach {
  readonly runs: number;
  readonly reached: Readonly<Record<string, number>>;
}

/** A parent automation whose run started a child run of another automation. */
export interface DashboardObservedInvocation {
  readonly childSlug: string;
  readonly parentSlug: string;
}

/**
 * A run's step. `finishedAt` null: it started and has not returned, or its execution died in it.
 * `executionNumber` names the execution that wrote it; `attempt` the retry attempt that execution
 * spent, the number people see.
 */
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
  /** The automation with what it invokes, as far as `scope` lets the viewer read. */
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
  /** Top-level runs queued since `since`, counted by status. */
  countRunsSince(
    environment: string,
    since: Date,
    scope: ReadScope,
  ): Promise<Readonly<Record<DashboardRunListItem["status"], number>>>;
  listDeploymentChanges(
    environment: string,
    since: Date,
    limit: number,
    scope: ReadScope,
  ): Promise<readonly DashboardDeploymentChange[]>;
  listRuns(query: DashboardRunsQuery): Promise<DashboardRunsResult>;
  listQueuedRuns(environment: string, scope: ReadScope): Promise<readonly DashboardQueuedRuns[]>;
  listRunSteps(runId: string): Promise<readonly DashboardRunStep[]>;
  /** Over the automation's last `limit` runs: how many reached each step. */
  countStepReach(
    automationSlug: string,
    environment: string,
    limit: number,
  ): Promise<DashboardStepReach>;
  /** One environment's heartbeats, or every environment's with `null`. */
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
  /** How many of the workers that reach the environment are online. */
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
