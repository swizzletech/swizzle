import type { AutomationConfig } from "@swizzle/config";
import type {
  ApprovalAssignee,
  ApprovalDecision,
  ExecutionWait,
  PlatformRunWaitReason,
  RunWait,
  StepResultInput,
} from "../run-approval.js";
import type {
  ErrorClassification,
  PlatformRunExecutionStatus,
  PlatformRunStatus,
  RunExecutionPhase,
  RunTriggerType,
  StoredArtifactLocator,
  StoredArtifactStorageBackend,
} from "./common.js";
import type {
  StoredRunExecutionConnectionUsage,
  StoredRunExecutionSecretUsage,
} from "./credentials.js";

export interface StoredAutomationStateEntry {
  readonly automationId: string;
  readonly environment: string;
  readonly key: string;
  readonly updatedAt: string;
  readonly value: unknown;
}

export interface ListAutomationStateInput {
  readonly automationId: string;
  readonly environment: string;
}

export interface GetAutomationStateValueInput extends ListAutomationStateInput {
  readonly key: string;
}

export interface SetAutomationStateValueInput extends GetAutomationStateValueInput {
  readonly updatedAt: string;
  readonly value: unknown;
}

export interface DeleteAutomationStateValueInput extends GetAutomationStateValueInput {}

export interface ClaimAutomationStateKeyInput extends GetAutomationStateValueInput {
  readonly runId: string;
  readonly updatedAt: string;
}

export interface StoredTimeoutGrant {
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly createdAt: string;
  readonly environment: string;
  readonly maxTimeoutMs: number;
  readonly note: string | null;
}

export interface AutomationTimeoutGrantKeyInput {
  readonly automationId: string;
  readonly environment: string;
}

export interface SetAutomationTimeoutGrantInput extends AutomationTimeoutGrantKeyInput {
  readonly maxTimeoutMs: number;
  readonly note?: string | null;
}

export interface ListTimeoutGrantAuditEventsInput extends AutomationTimeoutGrantKeyInput {
  readonly limit?: number;
}

/**
 * One step of a run. `finishedAt` set: the step has its result, which retries reuse. Unset: the
 * step started (`startedAt`) and has not returned; when the attempt died, that is where it broke.
 */
export interface StoredRunStepEntry {
  readonly approval: ApprovalDecision | null;
  readonly executionNumber: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly runId: string;
  readonly startedAt: string | null;
  readonly stepKey: string;
  readonly updatedAt: string;
  /** Null until the step finished. */
  readonly value: unknown;
}

export interface ListRunStepsInput {
  readonly runId: string;
}

export interface GetRunStepTotalsInput extends ListRunStepsInput {
  readonly stepKey: string;
}

/** What a run's steps hold against its step limits, and the row of one step key. */
export interface RunStepTotals {
  /** Step rows, started or finished. */
  readonly steps: number;
  /** JSON bytes of the stored results, as `stepResultBytes` counts them; a started step has none. */
  readonly resultBytes: number;
  /** The row of the asked key, null when the run has none. */
  readonly step: StoredRunStepEntry | null;
}

export type SetRunStepResultInput = ListRunStepsInput &
  StepResultInput & {
    readonly executionNumber: number;
    readonly stepKey: string;
  };

export interface StartRunStepInput extends ListRunStepsInput {
  readonly executionNumber: number;
  readonly startedAt: string;
  readonly stepKey: string;
}

export interface AppendRunExecutionOutputInput {
  readonly executionNumber: number;
  readonly runId: string;
  readonly stderr?: string;
  readonly stdout?: string;
}

/**
 * One execution of a run: one start of its process. `executionNumber` counts every execution of
 * the run; `attempt` is the retry attempt it spends against `runtime.retry.max_attempts`, which
 * starts again at 1 when the run resumes from a wait. People and the automation see the attempt.
 */
export interface StoredRunExecution {
  readonly executionId: string;
  readonly executionNumber: number;
  readonly attempt: number;
  /** The wait this execution suspended at; null unless its status is `suspended`. */
  readonly wait: ExecutionWait | null;
  /** The wait this execution resumed the run after: the previous execution's `wait`. */
  readonly resumedAfter: ExecutionWait | null;
  readonly durationMs: number | null;
  readonly errorCause: string | null;
  readonly errorClassification: ErrorClassification | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly errorStack: string | null;
  readonly finishedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly metadata: Record<string, unknown>;
  readonly phase: RunExecutionPhase;
  readonly queueJobId: string;
  readonly runId: string;
  readonly connectionUsages: readonly StoredRunExecutionConnectionUsage[];
  readonly secretUsages: readonly StoredRunExecutionSecretUsage[];
  readonly startedAt: string;
  readonly status: PlatformRunExecutionStatus;
  readonly stderr: string;
  readonly stdout: string;
  /** The worker that claimed the execution, by the name it had then. */
  readonly workerName: string;
}

export interface StoredRun {
  readonly artifactBackend: StoredArtifactStorageBackend;
  readonly artifactLocator: StoredArtifactLocator;
  readonly artifactRootPath: string;
  /** Every execution of the run, oldest first. */
  readonly executions: readonly StoredRunExecution[];
  /** Attempts since the run started or last resumed from a wait: the count `attemptsMax` bounds. */
  readonly attemptsMade: number;
  readonly attemptsMax: number;
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly config: AutomationConfig;
  /** The project the automation was in when the run was created; a move leaves it. */
  readonly projectId: string;
  /**
   * The run a chain run correlates under: its source run, or for a join the origin run its
   * sources share. Null for other triggers.
   */
  readonly chainOriginRunId: string | null;
  /** The source runs whose success started this chain run: one, or every source of a join. */
  readonly chainSourceRunIds: readonly string[];
  readonly correlationId: string | null;
  readonly deadLetterReason: string | null;
  readonly deploymentId: string;
  readonly environment: string;
  readonly errorCause: string | null;
  readonly errorClassification: ErrorClassification | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly errorStack: string | null;
  readonly finishedAt: string | null;
  readonly invokeDepth: number;
  readonly manifestPath: string;
  readonly payload: unknown;
  readonly parentRunId: string | null;
  readonly parentStepKey: string | null;
  readonly queueJobId: string;
  readonly queueName: string;
  readonly queuedAt: string;
  readonly result: unknown | null;
  readonly resumeCount: number;
  readonly runId: string;
  readonly sourceDirectory: string;
  readonly startedAt: string | null;
  readonly status: PlatformRunStatus;
  readonly stderr: string;
  readonly stdout: string;
  readonly triggerType: RunTriggerType;
  readonly version: string;
  readonly versionId: string;
  readonly wait: RunWait | null;
  readonly webhookContext: StoredWebhookRunContext | null;
}

export interface StoredWebhookRunContext {
  readonly headers: Record<string, string>;
  readonly rawBodyBase64: string;
  readonly rawBodyByteLength: number;
  readonly rawBodySha256: string;
}

export interface CreateRunInput {
  readonly attemptsMax: number;
  readonly automationId: string;
  readonly chainOriginRunId?: string | null;
  readonly chainSourceRunIds?: readonly string[];
  readonly correlationId?: string | null;
  readonly deploymentId: string;
  readonly invokeDepth?: number;
  readonly payload: unknown;
  readonly parentRunId?: string | null;
  readonly parentStepKey?: string | null;
  readonly queueJobId: string;
  readonly queueName: string;
  readonly runId: string;
  readonly triggerType: RunTriggerType;
  readonly versionId: string;
  readonly webhookContext?: StoredWebhookRunContext | null;
}

export interface FindSucceededChainSourceRunsInput {
  readonly chainOriginRunId: string;
  readonly environment: string;
  readonly sourceAutomationIds: readonly string[];
}

export interface CreateChainJoinRunInput extends CreateRunInput {
  readonly originRunId: string;
  readonly sourceRunIds: readonly string[];
  readonly triggerId: string;
}

export interface CreateRunExecutionInput {
  readonly executionNumber: number;
  readonly attempt: number;
  readonly workerName: string;
  readonly metadata?: Record<string, unknown>;
  readonly queueJobId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly status: PlatformRunExecutionStatus;
}

export interface CompleteRunExecutionInput {
  readonly executionNumber: number;
  readonly durationMs: number;
  readonly errorCause?: string | null;
  readonly errorClassification?: ErrorClassification | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly errorStack?: string | null;
  readonly finishedAt: string;
  readonly metadata?: Record<string, unknown>;
  readonly runId: string;
  readonly status: PlatformRunExecutionStatus;
  readonly stderr: string;
  readonly stdout: string;
  /** The wait a `suspended` execution stopped at. */
  readonly wait?: ExecutionWait;
}

export interface MarkRunExecutionReadyInput {
  readonly executionNumber: number;
  readonly runId: string;
}

export interface UpdateRunExecutionHeartbeatInput {
  readonly executionNumber: number;
  readonly heartbeatAt: string;
  readonly runId: string;
}

/** Pages queued runs in `queuedAt, runId` order: pass the last run id of a page to get the next. */
export interface ListQueuedRunsPageInput {
  readonly afterRunId?: string;
  readonly environment?: string;
  readonly limit?: number;
}

export interface ListDueSleepingRunsInput {
  readonly environment?: string;
  readonly limit?: number;
  readonly now: string;
}

export interface ListDueWaitingRunsInput {
  readonly environment?: string;
  readonly limit?: number;
  readonly now: string;
}

export interface ListWaitingEventRunsInput {
  readonly environment?: string;
  readonly limit?: number;
  readonly stepKey?: string;
}

export interface ListChildRunsInput {
  readonly parentRunId: string;
}

/**
 * Ends a wait in one commit: the run leaves `waiting` and the step gets its result, or neither
 * happens. Only the first of concurrent resolutions wins; the rest get null.
 */
export interface ResumeWaitingRunInput {
  readonly expectedWaitReason: PlatformRunWaitReason;
  readonly runId: string;
  readonly stepKey: string;
  readonly result: StepResultInput;
  /** When given, the wait must still be assigned to exactly this assignee. */
  readonly expectedAssignee?: ApprovalAssignee | null;
}

/** Moves an open approval from one assignee to another, if it is still open and still `from`'s. */
export interface ReassignApprovalInput {
  readonly runId: string;
  readonly stepKey: string;
  readonly from: ApprovalAssignee | null;
  readonly to: ApprovalAssignee;
}

export interface UpdateRunStateInput {
  readonly attemptsMade?: number;
  readonly deadLetterReason?: string | null;
  readonly errorCause?: string | null;
  readonly errorClassification?: ErrorClassification | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly errorStack?: string | null;
  readonly finishedAt?: string | null;
  readonly result?: unknown | null;
  readonly runId: string;
  readonly startedAt?: string | null;
  readonly status: PlatformRunStatus;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly wait?: RunWait | null;
}
