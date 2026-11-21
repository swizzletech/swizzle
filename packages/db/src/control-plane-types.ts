import type { CredentialGrant, CredentialKind, Subject } from "./access.js";

import type { AuditEventOf } from "./audit.js";
import type { NotificationEventType } from "./control-plane-types/common.js";
import type {
  BeginConnectionAuthorizationInput,
  ConnectionCredentials,
  ConnectionView,
  ConsumedConnectionAuthorization,
  CredentialAccess,
  CredentialPlace,
  CredentialShare,
  DeclaredCredentials,
  DeleteConnectionResult,
  DeploymentCredential,
  FindSecretDeclarationCollisionsInput,
  MarkConnectionErrorInput,
  RecordRunExecutionConnectionUsagesInput,
  RecordRunExecutionSecretUsagesInput,
  ResolveConnectionTokenInput,
  ResolveConnectionTokenResult,
  ResolvedSecret,
  SecretDeclarationCollision,
  SecretView,
  StoreConnectionTokensInput,
  StoredConnection,
  StoredCredential,
  StoredSecret,
  UpsertSecretInput,
} from "./control-plane-types/credentials.js";
import type {
  AdvanceCronTriggerCursorInput,
  CommitDeploymentInput,
  CommitDeploymentResult,
  CommitRollbackDeploymentInput,
  CreateDeploymentAuditEventInput,
  CreateTriggerAuditEventInput,
  DeleteAutomationInput,
  DeleteAutomationResult,
  DeleteProjectInput,
  DeleteProjectResult,
  MoveAutomationInput,
  ProjectContentCounts,
  StoredDeployment,
  StoredTrigger,
  UpdateTriggerStatusInput,
} from "./control-plane-types/deployments.js";
import type {
  AutomationOwner,
  CleanupMaintenanceInput,
  CleanupMaintenanceResult,
  CompleteAutomationCheckInput,
  CreateMaintenanceRunInput,
  CreateNotificationDeliveryInput,
  CreateNotificationRuleInput,
  CreateQueueMetricSampleInput,
  ExpireRunsInput,
  ExpireRunsResult,
  ListNotificationDeliveriesQuery,
  ListNotificationRulesQuery,
  ListQueueMetricSamplesQuery,
  MovedAutomation,
  NotificationDeliveryUpsertResult,
  RecordApiContactsInput,
  StoredApiContact,
  StoredAutomationCheck,
  StoredMaintenanceRun,
  StoredNotificationDelivery,
  StoredNotificationRule,
  StoredQueueMetricSample,
  UpdateNotificationDeliveryInput,
  UpdateNotificationRuleInput,
} from "./control-plane-types/operations.js";
import type {
  AppendRunExecutionOutputInput,
  AutomationTimeoutGrantKeyInput,
  ClaimAutomationStateKeyInput,
  CompleteRunExecutionInput,
  CreateChainJoinRunInput,
  CreateRunExecutionInput,
  CreateRunInput,
  DeleteAutomationStateValueInput,
  FindSucceededChainSourceRunsInput,
  GetAutomationStateValueInput,
  GetRunStepTotalsInput,
  ListAutomationStateInput,
  ListChildRunsInput,
  ListDueSleepingRunsInput,
  ListDueWaitingRunsInput,
  ListQueuedRunsPageInput,
  ListRunStepsInput,
  ListTimeoutGrantAuditEventsInput,
  ListWaitingEventRunsInput,
  MarkRunExecutionReadyInput,
  ReassignApprovalInput,
  ResumeWaitingRunInput,
  RunStepTotals,
  SetAutomationStateValueInput,
  SetAutomationTimeoutGrantInput,
  SetRunStepResultInput,
  StartRunStepInput,
  StoredAutomationStateEntry,
  StoredRun,
  StoredRunStepEntry,
  StoredTimeoutGrant,
  UpdateRunExecutionHeartbeatInput,
  UpdateRunStateInput,
} from "./control-plane-types/runs.js";
import type { ApprovalAssignee, AssigneeRequest } from "./run-approval.js";

export interface ControlPlaneStore {
  markRunTerminalPending(runId: string): Promise<void>;
  recordRunEnqueueError(runId: string, message: string): Promise<void>;
  cancelRun(input: {
    readonly runId: string;
    readonly finishedAt: string;
  }): Promise<{ readonly alreadyTerminal: boolean; readonly run: StoredRun }>;
  findAutomation(automationSlug: string): Promise<AutomationOwner | null>;
  appendRunExecutionOutput(input: AppendRunExecutionOutputInput): Promise<void>;
  advanceCronTriggerCursor(input: AdvanceCronTriggerCursorInput): Promise<boolean>;
  cleanupMaintenanceData(input: CleanupMaintenanceInput): Promise<CleanupMaintenanceResult>;
  close(): Promise<void>;
  commitDeployment(input: CommitDeploymentInput): Promise<CommitDeploymentResult>;
  commitRollbackDeployment(input: CommitRollbackDeploymentInput): Promise<CommitDeploymentResult>;
  completeRunExecution(input: CompleteRunExecutionInput): Promise<void>;
  completeAutomationCheck(input: CompleteAutomationCheckInput): Promise<boolean>;
  getAutomationCheck(checkId: string): Promise<StoredAutomationCheck | null>;
  listDueAutomationChecks(
    now: string,
    environment: string,
  ): Promise<readonly StoredAutomationCheck[]>;
  recordApiContacts(input: RecordApiContactsInput): Promise<readonly StoredApiContact[]>;
  countActiveRunsForAutomation(
    automationId: string,
    environment: string,
    excludeRunId?: string,
  ): Promise<number>;
  countDeadLetteredFailuresSince(
    automationId: string,
    environment: string,
    since: string,
  ): Promise<number>;
  createDeploymentAuditEvent(input: CreateDeploymentAuditEventInput): Promise<void>;
  createMaintenanceRun(input: CreateMaintenanceRunInput): Promise<StoredMaintenanceRun>;
  createNotificationRule(input: CreateNotificationRuleInput): Promise<StoredNotificationRule>;
  createQueueMetricSample(input: CreateQueueMetricSampleInput): Promise<StoredQueueMetricSample>;
  createChainJoinRun(input: CreateChainJoinRunInput): Promise<StoredRun | null>;
  createRun(input: CreateRunInput): Promise<StoredRun>;
  createRunExecution(input: CreateRunExecutionInput): Promise<void>;
  createTriggerAuditEvent(input: CreateTriggerAuditEventInput): Promise<void>;
  deleteAutomationTimeoutGrant(input: AutomationTimeoutGrantKeyInput): Promise<boolean>;
  deleteNotificationRule(ruleId: string): Promise<boolean>;
  deleteAutomationStateValue(input: DeleteAutomationStateValueInput): Promise<boolean>;
  deleteSecret(secretId: string): Promise<boolean>;
  getAutomationTimeoutGrant(
    input: AutomationTimeoutGrantKeyInput,
  ): Promise<StoredTimeoutGrant | null>;
  listAutomationTimeoutGrants(environment: string): Promise<readonly StoredTimeoutGrant[]>;
  listAutomationTimeoutGrantAuditEvents(
    input: ListTimeoutGrantAuditEventsInput,
  ): Promise<readonly AuditEventOf<"timeout-grant">[]>;
  setAutomationTimeoutGrant(input: SetAutomationTimeoutGrantInput): Promise<StoredTimeoutGrant>;
  findSecretDeclarationCollisions(
    input: FindSecretDeclarationCollisionsInput,
  ): Promise<readonly SecretDeclarationCollision[]>;
  findSucceededChainSourceRuns(
    input: FindSucceededChainSourceRunsInput,
  ): Promise<readonly StoredRun[]>;
  getActiveDeploymentBySlug(
    automationSlug: string,
    environment: string,
  ): Promise<StoredDeployment | null>;
  getAutomationTriggerBySlug(
    automationSlug: string,
    environment: string,
  ): Promise<StoredTrigger | null>;
  getDeploymentById(deploymentId: string): Promise<StoredDeployment | null>;
  getDueCronTriggers(
    now: string,
    environment: string,
    limit?: number,
  ): Promise<readonly StoredTrigger[]>;
  getLatestMaintenanceRun(environment: string): Promise<StoredMaintenanceRun | null>;
  getLatestNotificationDeliveryForRule(
    ruleId: string,
    environment: string,
    automationId: string,
    eventType: NotificationEventType,
  ): Promise<StoredNotificationDelivery | null>;
  getNotificationRule(ruleId: string): Promise<StoredNotificationRule | null>;
  getRun(runId: string): Promise<StoredRun | null>;
  getSecret(name: string, place: CredentialPlace): Promise<SecretView | null>;
  getAutomationStateValue(
    input: GetAutomationStateValueInput,
  ): Promise<StoredAutomationStateEntry | null>;
  getWebhookTriggerByPath(webhookPath: string, environment: string): Promise<StoredTrigger | null>;
  listDeploymentAuditEventsByAutomationSlug(
    automationSlug: string,
    environment: string,
    limit?: number,
  ): Promise<readonly AuditEventOf<"deployment">[]>;
  listDeploymentsByAutomationSlug(
    automationSlug: string,
    environment: string,
  ): Promise<readonly StoredDeployment[]>;
  listActiveDeployments(): Promise<readonly StoredDeployment[]>;
  listDeploymentsForArtifactRetention(environment: string): Promise<readonly StoredDeployment[]>;
  listNotificationDeliveries(
    query: ListNotificationDeliveriesQuery,
  ): Promise<readonly StoredNotificationDelivery[]>;
  listNotificationRules(
    query: ListNotificationRulesQuery,
  ): Promise<readonly StoredNotificationRule[]>;
  listQueueMetricSamples(
    query: ListQueueMetricSamplesQuery,
  ): Promise<readonly StoredQueueMetricSample[]>;
  listChildRuns(input: ListChildRunsInput): Promise<readonly StoredRun[]>;
  listDueSleepingRuns(input: ListDueSleepingRunsInput): Promise<readonly StoredRun[]>;
  listDueWaitingRuns(input: ListDueWaitingRunsInput): Promise<readonly StoredRun[]>;
  listSecrets(
    environment: string,
    projectIds: readonly string[] | "all",
  ): Promise<readonly SecretView[]>;
  listAutomationState(
    input: ListAutomationStateInput,
  ): Promise<readonly StoredAutomationStateEntry[]>;
  listRunSteps(input: ListRunStepsInput): Promise<readonly StoredRunStepEntry[]>;
  getRunStepTotals(input: GetRunStepTotalsInput): Promise<RunStepTotals>;
  listQueuedRuns(input: ListQueuedRunsPageInput): Promise<readonly StoredRun[]>;
  listWaitingEventRuns(input: ListWaitingEventRunsInput): Promise<readonly StoredRun[]>;
  listTriggerAuditEventsByAutomationSlug(
    automationSlug: string,
    environment: string,
    limit?: number,
  ): Promise<readonly AuditEventOf<"trigger">[]>;
  expireRuns(input: ExpireRunsInput): Promise<ExpireRunsResult>;
  recordNotificationDelivery(
    input: CreateNotificationDeliveryInput,
  ): Promise<NotificationDeliveryUpsertResult>;
  beginConnectionAuthorization(input: BeginConnectionAuthorizationInput): Promise<ConnectionView>;
  consumeConnectionAuthorization(
    stateHash: string,
  ): Promise<ConsumedConnectionAuthorization | null>;
  deleteConnection(connectionId: string): Promise<DeleteConnectionResult>;
  getConnection(name: string, place: CredentialPlace): Promise<ConnectionView | null>;
  getConnectionCredentials(
    name: string,
    place: CredentialPlace,
  ): Promise<ConnectionCredentials | null>;
  listConnections(
    environment: string,
    projectIds: readonly string[] | "all",
  ): Promise<readonly ConnectionView[]>;
  markConnectionError(input: MarkConnectionErrorInput): Promise<StoredConnection | null>;
  recordRunExecutionConnectionUsages(input: RecordRunExecutionConnectionUsagesInput): Promise<void>;
  recordRunExecutionSecretUsages(input: RecordRunExecutionSecretUsagesInput): Promise<void>;
  resolveConnectionToken(input: ResolveConnectionTokenInput): Promise<ResolveConnectionTokenResult>;
  storeConnectionTokens(input: StoreConnectionTokensInput): Promise<StoredConnection | null>;
  resolveSecrets(secretIds: readonly string[]): Promise<readonly ResolvedSecret[]>;
  resumeWaitingRun(input: ResumeWaitingRunInput): Promise<StoredRun | null>;
  reassignApproval(input: ReassignApprovalInput): Promise<boolean>;
  resolveApprovalAssignee(request: AssigneeRequest): Promise<ApprovalAssignee | null>;
  personMayRead(
    userId: string,
    target: {
      readonly automationId: string;
      readonly projectId: string;
      readonly environment: string;
    },
  ): Promise<boolean>;
  deleteAutomation(input: DeleteAutomationInput): Promise<DeleteAutomationResult>;
  listAutomationChainDependents(
    automationSlug: string,
  ): Promise<
    readonly Pick<StoredTrigger, "automationId" | "automationSlug" | "projectId" | "environment">[]
  >;
  countProjectContents(projectId: string): Promise<ProjectContentCounts | null>;
  deleteProject(input: DeleteProjectInput): Promise<DeleteProjectResult>;
  moveAutomation(input: MoveAutomationInput): Promise<MovedAutomation>;
  getChainTriggersForSource(
    sourceAutomationId: string,
    environment: string,
  ): Promise<readonly StoredTrigger[]>;
  updateAutomationTriggerStatus(input: UpdateTriggerStatusInput): Promise<StoredTrigger | null>;
  updateNotificationDelivery(
    input: UpdateNotificationDeliveryInput,
  ): Promise<StoredNotificationDelivery | null>;
  updateNotificationRule(
    input: UpdateNotificationRuleInput,
  ): Promise<StoredNotificationRule | null>;
  markRunExecutionReady(input: MarkRunExecutionReadyInput): Promise<void>;
  updateRunExecutionHeartbeat(input: UpdateRunExecutionHeartbeatInput): Promise<boolean>;
  updateRunState(input: UpdateRunStateInput): Promise<void>;
  setAutomationStateValue(input: SetAutomationStateValueInput): Promise<StoredAutomationStateEntry>;
  claimAutomationStateKey(input: ClaimAutomationStateKeyInput): Promise<boolean>;
  setRunStepResult(input: SetRunStepResultInput): Promise<StoredRunStepEntry>;
  startRunStep(input: StartRunStepInput): Promise<StoredRunStepEntry>;
  upsertSecret(input: UpsertSecretInput): Promise<StoredSecret>;

  findCredential(
    kind: CredentialKind,
    name: string,
    place: CredentialPlace,
  ): Promise<StoredCredential | null>;
  credentialAccess(credentials: readonly StoredCredential[]): Promise<readonly CredentialAccess[]>;
  setCredentialGrant(credential: StoredCredential, grant: CredentialGrant): Promise<void>;
  removeCredentialGrant(credential: StoredCredential, subject: Subject): Promise<boolean>;
  offerCredentialShare(input: {
    readonly credential: StoredCredential;
    readonly projectId: string;
    readonly offeredBy: string | null;
    readonly accepted: boolean;
  }): Promise<CredentialShare>;
  acceptCredentialShare(input: {
    readonly shareId: string;
    readonly projectId: string;
    readonly acceptedBy: string | null;
  }): Promise<CredentialShare | null>;
  removeCredentialShare(shareId: string): Promise<boolean>;
  listCredentialShares(projectId: string): Promise<readonly CredentialShare[]>;
  findDeploymentCredentials(
    declared: DeclaredCredentials,
  ): Promise<readonly DeploymentCredential[]>;
  boundCredentials(deploymentId: string, projectId: string): Promise<readonly StoredCredential[]>;
}

export type {
  ErrorClassification,
  MaintenanceRunStatus,
  NotificationChannel,
  NotificationDeliveryEventType,
  NotificationDeliveryStatus,
  NotificationEventType,
  PlatformRunExecutionStatus,
  PlatformRunStatus,
  PlatformTriggerStatus,
  PlatformTriggerType,
  RunTriggerType,
  StoredArtifactLocator,
  StoredArtifactStorageBackend,
  StoredBuildSnapshot,
  StoredBuildStep,
  StoredRuntimeSnapshot,
} from "./control-plane-types/common.js";
export type {
  BeginConnectionAuthorizationInput,
  ConnectionCredentials,
  ConnectionRefreshOutcome,
  ConnectionStatus,
  ConnectionTokenPayload,
  ConnectionView,
  ConsumedConnectionAuthorization,
  CredentialAccess,
  CredentialAccessView,
  CredentialPlace,
  CredentialShare,
  CredentialState,
  DeclaredConnectionStatus,
  DeclaredCredentials,
  DeleteConnectionResult,
  DeploymentCredential,
  FindSecretDeclarationCollisionsInput,
  MarkConnectionErrorInput,
  RecordRunExecutionConnectionUsagesInput,
  RecordRunExecutionSecretUsagesInput,
  ResolveConnectionTokenInput,
  ResolveConnectionTokenResult,
  ResolvedSecret,
  SecretDeclarationCollision,
  SecretView,
  SharedCredential,
  StoreConnectionTokensInput,
  StoredConnection,
  StoredConnectionUsage,
  StoredCredential,
  StoredRunExecutionConnectionUsage,
  StoredRunExecutionSecretUsage,
  StoredSecret,
  StoredSecretUsage,
  UpsertSecretInput,
} from "./control-plane-types/credentials.js";
export type {
  AdvanceCronTriggerCursorInput,
  CommitDeploymentAuditInput,
  CommitDeploymentInput,
  CommitDeploymentResult,
  CommitRollbackDeploymentInput,
  CreateDeploymentAuditEventInput,
  CreateTriggerAuditEventInput,
  DeleteAutomationArtifactRef,
  DeleteAutomationCounts,
  DeleteAutomationInput,
  DeleteAutomationResult,
  DeleteProjectInput,
  DeleteProjectResult,
  DeploymentTriggerInput,
  KeptAutomationHistory,
  MoveAutomationInput,
  PersistDeploymentInput,
  ProjectContentCounts,
  ProjectContents,
  RollbackDeploymentInput,
  StoredDeployment,
  StoredTrigger,
  UpdateTriggerStatusInput,
} from "./control-plane-types/deployments.js";
export type {
  ApiContactObservation,
  ApiNoticeObservation,
  AutomationCheckStatus,
  AutomationOwner,
  CleanupMaintenanceInput,
  CleanupMaintenanceResult,
  CompleteAutomationCheckInput,
  CreateMaintenanceRunInput,
  CreateNotificationDeliveryInput,
  CreateNotificationRuleInput,
  CreateQueueMetricSampleInput,
  ExpireRunsInput,
  ExpireRunsResult,
  ListNotificationDeliveriesQuery,
  ListNotificationRulesQuery,
  ListQueueMetricSamplesQuery,
  MovedAutomation,
  NotificationDeliveryUpsertResult,
  RecordApiContactsInput,
  StoredApiContact,
  StoredAutomationCheck,
  StoredMaintenanceRun,
  StoredNotificationDelivery,
  StoredNotificationRule,
  StoredQueueMetricSample,
  UpdateNotificationDeliveryInput,
  UpdateNotificationRuleInput,
} from "./control-plane-types/operations.js";
export type {
  AppendRunExecutionOutputInput,
  AutomationTimeoutGrantKeyInput,
  ClaimAutomationStateKeyInput,
  CompleteRunExecutionInput,
  CreateChainJoinRunInput,
  CreateRunExecutionInput,
  CreateRunInput,
  DeleteAutomationStateValueInput,
  FindSucceededChainSourceRunsInput,
  GetAutomationStateValueInput,
  GetRunStepTotalsInput,
  ListAutomationStateInput,
  ListChildRunsInput,
  ListDueSleepingRunsInput,
  ListDueWaitingRunsInput,
  ListQueuedRunsPageInput,
  ListRunStepsInput,
  ListTimeoutGrantAuditEventsInput,
  ListWaitingEventRunsInput,
  MarkRunExecutionReadyInput,
  ReassignApprovalInput,
  ResumeWaitingRunInput,
  RunStepTotals,
  SetAutomationStateValueInput,
  SetAutomationTimeoutGrantInput,
  SetRunStepResultInput,
  StartRunStepInput,
  StoredAutomationStateEntry,
  StoredRun,
  StoredRunExecution,
  StoredRunStepEntry,
  StoredTimeoutGrant,
  StoredWebhookRunContext,
  UpdateRunExecutionHeartbeatInput,
  UpdateRunStateInput,
} from "./control-plane-types/runs.js";
