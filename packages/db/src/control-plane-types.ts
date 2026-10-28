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
  /** Records a publication error only while the durable run remains queued. */
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
  /** Writes a check's outcome. False when the row moved on, as a deploy does, so a stale result is dropped. */
  completeAutomationCheck(input: CompleteAutomationCheckInput): Promise<boolean>;
  getAutomationCheck(checkId: string): Promise<StoredAutomationCheck | null>;
  /** Checks whose `nextCheckAt` passed and whose trigger is active, oldest first; one per automation at most. */
  listDueAutomationChecks(
    now: string,
    environment: string,
  ): Promise<readonly StoredAutomationCheck[]>;
  /** Upserts one row per host; returns the rows whose retirement notice this write recorded first. */
  recordApiContacts(input: RecordApiContactsInput): Promise<readonly StoredApiContact[]>;
  countActiveRunsForAutomation(
    automationId: string,
    environment: string,
    excludeRunId?: string,
  ): Promise<number>;
  countDeadLetteredRunsSince(
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
  /** Deletes the secret with this id, never another one that took its name. */
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
  /**
   * Latest delivery of a rule's own event for one automation, so a rule for all automations cools
   * down per automation and an API alert starts no cooldown.
   */
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
  /** The secrets of these projects in one environment; every project's with `projectIds: "all"`. */
  listSecrets(
    environment: string,
    projectIds: readonly string[] | "all",
  ): Promise<readonly SecretView[]>;
  listAutomationState(
    input: ListAutomationStateInput,
  ): Promise<readonly StoredAutomationStateEntry[]>;
  listRunSteps(input: ListRunStepsInput): Promise<readonly StoredRunStepEntry[]>;
  /** The run's step totals and one step's row, without reading the run's other steps. */
  getRunStepTotals(input: GetRunStepTotalsInput): Promise<RunStepTotals>;
  listQueuedRuns(input: ListQueuedRunsPageInput): Promise<readonly StoredRun[]>;
  listWaitingEventRuns(input: ListWaitingEventRunsInput): Promise<readonly StoredRun[]>;
  listTriggerAuditEventsByAutomationSlug(
    automationSlug: string,
    environment: string,
    limit?: number,
  ): Promise<readonly AuditEventOf<"trigger">[]>;
  /**
   * Deletes finished runs (succeeded, failed, dead-lettered) that finished at or before the
   * cutoff in the named environment, with everything that hangs off them. Queued, running and
   * waiting runs never expire.
   */
  expireRuns(input: ExpireRunsInput): Promise<ExpireRunsResult>;
  recordNotificationDelivery(
    input: CreateNotificationDeliveryInput,
  ): Promise<NotificationDeliveryUpsertResult>;
  beginConnectionAuthorization(input: BeginConnectionAuthorizationInput): Promise<ConnectionView>;
  consumeConnectionAuthorization(
    stateHash: string,
  ): Promise<ConsumedConnectionAuthorization | null>;
  /** Deletes the connection with this id, never another one that took its name. */
  deleteConnection(connectionId: string): Promise<DeleteConnectionResult>;
  getConnection(name: string, place: CredentialPlace): Promise<ConnectionView | null>;
  getConnectionCredentials(
    name: string,
    place: CredentialPlace,
  ): Promise<ConnectionCredentials | null>;
  /** The connections of these projects in one environment; every project's with `projectIds: "all"`. */
  listConnections(
    environment: string,
    projectIds: readonly string[] | "all",
  ): Promise<readonly ConnectionView[]>;
  markConnectionError(input: MarkConnectionErrorInput): Promise<StoredConnection | null>;
  recordRunExecutionConnectionUsages(input: RecordRunExecutionConnectionUsagesInput): Promise<void>;
  recordRunExecutionSecretUsages(input: RecordRunExecutionSecretUsagesInput): Promise<void>;
  resolveConnectionToken(input: ResolveConnectionTokenInput): Promise<ResolveConnectionTokenResult>;
  /** Null when the connection is gone, for example deleted while the code was exchanged. */
  storeConnectionTokens(input: StoreConnectionTokensInput): Promise<StoredConnection | null>;
  /** The values of these secrets, by id; a run asks `boundCredentials` for the ids first. */
  resolveSecrets(secretIds: readonly string[]): Promise<readonly ResolvedSecret[]>;
  resumeWaitingRun(input: ResumeWaitingRunInput): Promise<StoredRun | null>;
  /** False when the approval was decided, timed out or reassigned meanwhile. */
  reassignApproval(input: ReassignApprovalInput): Promise<boolean>;
  /** The person or team an automation names, by email or team name; null when there is none. */
  resolveApprovalAssignee(request: AssigneeRequest): Promise<ApprovalAssignee | null>;
  /**
   * Whether a person may read a run of this automation in this environment now: not suspended,
   * not removed, and holding a grant (access.ts). A notification asks before it sends.
   */
  personMayRead(
    userId: string,
    target: {
      readonly automationId: string;
      readonly projectId: string;
      readonly environment: string;
    },
  ): Promise<boolean>;
  /**
   * Deletes an automation with everything it owns, its runs included (ADR 0015), and the chain
   * invalidates chain triggers of other automations that name it as a source. Only its audit events stay. Refuses
   * while a trigger is active or a run is unfinished.
   */
  deleteAutomation(input: DeleteAutomationInput): Promise<DeleteAutomationResult>;
  /** Chain triggers in every environment whose source would be deleted, including paused ones. */
  listAutomationChainDependents(
    automationSlug: string,
  ): Promise<
    readonly Pick<StoredTrigger, "automationId" | "automationSlug" | "projectId" | "environment">[]
  >;
  /** What a project holds that deleting it must decide about; null when there is no project. */
  countProjectContents(projectId: string): Promise<ProjectContentCounts | null>;
  /**
   * Deletes a project in one transaction, after moving its automations, credentials and runs to
   * another project or deleting them (ProjectContents). Refuses the default project.
   */
  deleteProject(input: DeleteProjectInput): Promise<DeleteProjectResult>;
  /**
   * Moves a live automation to another project and drops its automation grants and folder. Runs
   * and audit events stay in the project they happened in. It decides `moved` under the row
   * lock, so a concurrent move cannot make it report the wrong outcome.
   */
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
  /**
   * Records that a running attempt is alive. Returns false, and records nothing, once the attempt
   * is no longer running: a cancel or the stalled-run reconciler finished it, in whichever process.
   */
  markRunExecutionReady(input: MarkRunExecutionReadyInput): Promise<void>;
  updateRunExecutionHeartbeat(input: UpdateRunExecutionHeartbeatInput): Promise<boolean>;
  updateRunState(input: UpdateRunStateInput): Promise<void>;
  setAutomationStateValue(input: SetAutomationStateValueInput): Promise<StoredAutomationStateEntry>;
  /** Claims a state key for a run unless another run holds it; true when this run holds it. */
  claimAutomationStateKey(input: ClaimAutomationStateKeyInput): Promise<boolean>;
  setRunStepResult(input: SetRunStepResultInput): Promise<StoredRunStepEntry>;
  /** Records that a step runs; a later attempt restarting an unfinished step moves its start. */
  startRunStep(input: StartRunStepInput): Promise<StoredRunStepEntry>;
  upsertSecret(input: UpsertSecretInput): Promise<StoredSecret>;

  // Credential rights (access.ts decides; these read and write the grants, shares and bindings).
  findCredential(
    kind: CredentialKind,
    name: string,
    place: CredentialPlace,
  ): Promise<StoredCredential | null>;
  /** The grants and shares of each credential, in the order given. */
  credentialAccess(credentials: readonly StoredCredential[]): Promise<readonly CredentialAccess[]>;
  setCredentialGrant(credential: StoredCredential, grant: CredentialGrant): Promise<void>;
  /** False when there was no such grant. */
  removeCredentialGrant(credential: StoredCredential, subject: Subject): Promise<boolean>;
  /** Offers the credential to a project, or keeps the offer that exists; `accepted` accepts it at once. */
  offerCredentialShare(input: {
    readonly credential: StoredCredential;
    readonly projectId: string;
    readonly offeredBy: string | null;
    readonly accepted: boolean;
  }): Promise<CredentialShare>;
  /** Null when the project has no such share. */
  acceptCredentialShare(input: {
    readonly shareId: string;
    readonly projectId: string;
    readonly acceptedBy: string | null;
  }): Promise<CredentialShare | null>;
  /** Deletes the share and every deployment binding made through it; false when there was none. */
  removeCredentialShare(shareId: string): Promise<boolean>;
  /** The shares offered to a project, accepted or not. */
  listCredentialShares(projectId: string): Promise<readonly CredentialShare[]>;
  /** The credential each declared name would bind; a name without an entry binds nothing. */
  findDeploymentCredentials(
    declared: DeclaredCredentials,
  ): Promise<readonly DeploymentCredential[]>;
  /**
   * The credentials a deployment may still inject into a run of `projectId`: bound when it was
   * published, not deleted since, and the project's own or shared into it.
   */
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
