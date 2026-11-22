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

export interface StoredRunStepEntry {
  readonly approval: ApprovalDecision | null;
  readonly executionNumber: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly runId: string;
  readonly startedAt: string | null;
  readonly stepKey: string;
  readonly updatedAt: string;
  readonly value: unknown;
}

export interface ListRunStepsInput {
  readonly runId: string;
}

export interface GetRunStepTotalsInput extends ListRunStepsInput {
  readonly stepKey: string;
}

export interface RunStepTotals {
  readonly steps: number;
  readonly resultBytes: number;
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

export interface StoredRunExecution {
  readonly executionId: string;
  readonly executionNumber: number;
  readonly attempt: number;
  readonly wait: ExecutionWait | null;
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
  readonly workerName: string;
}

export interface StoredRun {
  readonly artifactBackend: StoredArtifactStorageBackend;
  readonly artifactLocator: StoredArtifactLocator;
  readonly artifactRootPath: string;
  readonly executions: readonly StoredRunExecution[];
  readonly attemptsMade: number;
  readonly attemptsMax: number;
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly config: AutomationConfig;
  readonly projectId: string;
  readonly chainOriginRunId: string | null;
  readonly chainSourceRunIds: readonly string[];
  readonly correlationId: string | null;
  readonly cancelledWaitStepKey: string | null;
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

export interface ResumeWaitingRunInput {
  readonly expectedWaitReason: PlatformRunWaitReason;
  readonly runId: string;
  readonly stepKey: string;
  readonly result: StepResultInput;
  readonly expectedAssignee?: ApprovalAssignee | null;
}

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
