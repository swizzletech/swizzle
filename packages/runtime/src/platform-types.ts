import type {
  ApprovalAssignee,
  ApprovalDecider,
  AssigneeRequest,
  AuditEventOf,
  AuditTarget,
  AutomationOwner,
  ControlPlaneStore,
  CredentialPlace,
  DashboardStore,
  PlatformRunExecutionStatus as DbPlatformRunExecutionStatus,
  PlatformRunStatus as DbPlatformRunStatus,
  DeleteProjectInput,
  DeploymentCredential,
  MovedAutomation,
  NotificationDeliveryEventType,
  NotificationDeliveryStatus,
  NotificationEventType,
  ProjectContentCounts,
  ReadScope,
  SecretDeclarationCollision,
  SecretView,
  StoredAutomationStateEntry,
  StoredDeployment,
  StoredMaintenanceRun,
  StoredNotificationDelivery,
  StoredNotificationRule,
  StoredQueueMetricSample,
  StoredRun,
  StoredSecret,
  StoredTimeoutGrant,
  StoredTrigger,
  Subject,
} from "@swizzle/db";

import type { DeployAutomationOptions } from "./deploy.js";
import type { MaintenanceCycleResult, MaintenanceRetentionPolicy } from "./maintenance.js";
import type { ConnectionCallbackResult, PlatformConnectionRecord } from "./platform-connections.js";
import type {
  BeginConnectionAuthorizationResult,
  CancelRunResult,
  DeleteAutomationResultRecord,
  DeleteProjectResultRecord,
  ManualTriggerRunRecord,
  PlatformApplyResult,
  PlatformDeploymentCheck,
  PlatformDeploymentRecord,
  PlatformReadinessReport,
  PlatformRunDetail,
  TestConnectionResult,
} from "./platform-records.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { WaitLinkKind } from "./wait-links.js";

export type PlatformRunRecord = StoredRun;

export type ResolveWaitingEventRunResult =
  | { readonly status: "resolved"; readonly run: PlatformRunRecord }
  | { readonly status: "not-waiting"; readonly run: PlatformRunRecord }
  | { readonly status: "key-mismatch"; readonly run: PlatformRunRecord };

/** The open wait a valid link resolves, with what its public page shows. */
export interface OpenWaitRecord {
  readonly automationName: string;
  readonly details: unknown | null;
  /** When the link stops working: the wait's `until`, or a bounded default after it began. */
  readonly expiresAt: string;
  readonly runId: string;
  readonly stepKey: string;
}

/**
 * What a public link finds. `closed` is a valid link whose wait is over (decided, timed out,
 * expired or cancelled); `not-found` is everything else, a forged token included. A valid link
 * names its run as `target`, so the audit event of a link request names it too.
 */
export type WaitLinkLookupResult =
  | { readonly status: "open"; readonly target: AuditTarget; readonly wait: OpenWaitRecord }
  /** An approval assigned to a person or a team: only they decide it, signed in. */
  | {
      readonly status: "assigned";
      readonly target: AuditTarget;
      readonly assignee: ApprovalAssignee;
    }
  | { readonly status: "closed"; readonly target: AuditTarget }
  | { readonly status: "not-found" };

export type PlatformTriggerRecord = StoredTrigger;
type PlatformSecretRecord = StoredSecret;
type PlatformNotificationRuleRecord = StoredNotificationRule;
export type PlatformNotificationDeliveryRecord = StoredNotificationDelivery;
export type PlatformMaintenanceRunRecord = StoredMaintenanceRun;
export type PlatformQueueMetricSampleRecord = StoredQueueMetricSample;
export type PlatformRunExecutionStatus = DbPlatformRunExecutionStatus;
export type PlatformRunStatus = DbPlatformRunStatus;

export interface PlatformDeployOptions extends DeployAutomationOptions {
  readonly environment: string;
  /**
   * The source hash the uploader computed from the same files. A different server hash refuses the
   * deployment with `DEPLOYMENT_CONTENT_HASH_MISMATCH` before anything is stored or activated.
   */
  readonly expectedSourceHash?: string;
  readonly force?: boolean;
  /**
   * Picks the project the automation belongs to, given the project it already has, and throws to
   * refuse the deployment; the API checks the deployer's access here. Without it an existing
   * automation keeps its project and a new one joins DEFAULT_PROJECT_ID.
   */
  readonly project?: (automation: {
    readonly automationSlug: string;
    readonly current: AutomationOwner | null;
  }) => Promise<string>;
  /**
   * Called with what a changed version would bind, before the build and again right before the
   * commit; throws to refuse a credential the deployer may not use. The API checks the deployer's
   * use rights here.
   */
  readonly credentials?: (
    bound: readonly DeploymentCredential[],
    projectId: string,
  ) => Promise<void>;
  readonly skipReadinessCheck?: boolean;
}

interface EnqueuePlatformRunOptions {
  readonly automationName: string;
  readonly environment: string;
  readonly payload?: unknown;
  readonly runId?: string;
  readonly triggerType?: "cron" | "webhook";
  readonly webhookContext?: StoredRun["webhookContext"];
}

interface TriggerWebhookByPathOptions {
  readonly correlationId?: string | null;
  readonly environment: string;
  readonly path: string;
  readonly payload?: unknown;
  readonly webhookContext?: StoredRun["webhookContext"];
}

interface RollbackOptions {
  readonly automationName: string;
  readonly environment: string;
  readonly targetDeploymentId: string;
}

interface DeleteAutomationOptions {
  readonly automationName: string;
  readonly environment: string;
}

interface StartManualRunOptions {
  readonly automationName: string;
  readonly correlationId?: string | null;
  readonly environment: string;
  readonly payload?: unknown;
}

interface MaterializeCronRunsOptions {
  readonly environment: string;
  readonly limit?: number;
  readonly now?: Date;
}

interface ResumeDueWaitingRunsOptions {
  readonly environment: string;
  readonly limit?: number;
  readonly now?: Date;
}

interface ResumeDueWaitingRunsResult {
  readonly resumedCount: number;
  readonly resumedRunIds: readonly string[];
  readonly skippedRunIds: readonly string[];
}

interface ResolveRunEventOptions {
  readonly runId: string;
  readonly stepKey: string;
  readonly value?: unknown;
}

interface DecideApprovalOptions {
  readonly runId: string;
  readonly stepKey: string;
  readonly approved: boolean;
  readonly comment: string | null;
  readonly decidedBy: ApprovalDecider;
  /** The assignee the decider was checked against; the decision lands only while it holds. */
  readonly assignee: ApprovalAssignee | null;
}

interface ReassignApprovalOptions {
  readonly runId: string;
  readonly stepKey: string;
  readonly from: ApprovalAssignee | null;
  readonly to: ApprovalAssignee;
}

interface WaitLinkOptions {
  readonly kind: WaitLinkKind;
  readonly token: string;
}

export interface CreateNotificationRuleOptions {
  /** The person the rule belongs to and reaches. */
  readonly userId: string;
  readonly projectId: string;
  /** Null for a rule that covers every automation of the project. */
  readonly automationId: string | null;
  readonly chatId: string;
  readonly cooldownSeconds?: number;
  readonly enabled?: boolean;
  readonly environment: string;
  readonly eventType: NotificationEventType;
  readonly threshold?: number;
  readonly windowSeconds?: number;
}

interface UpdateNotificationRuleOptions {
  readonly chatId?: string;
  readonly cooldownSeconds?: number;
  readonly enabled?: boolean;
  readonly ruleId: string;
  readonly threshold?: number;
  readonly windowSeconds?: number;
}

interface ListNotificationDeliveriesOptions {
  readonly automationName?: string;
  /** Only deliveries created at or after this ISO time. */
  readonly createdSince?: string;
  readonly environment: string;
  readonly eventType?: NotificationDeliveryEventType;
  readonly limit?: number;
  /**
   * Only deliveries of the rules this person made, for automations they still read: a rule
   * outlives the grant it was made under.
   */
  readonly ruleOwner?: { readonly userId: string; readonly scope: ReadScope };
  readonly status?: NotificationDeliveryStatus;
}

export interface RunMaintenanceOptions {
  readonly environment: string;
  readonly now?: Date;
  readonly retention?: Partial<MaintenanceRetentionPolicy>;
}

interface AutomationStateSetOptions {
  readonly automationName: string;
  readonly environment: string;
  readonly key: string;
  readonly value: unknown;
}

interface AutomationStateKeyOptions {
  readonly automationName: string;
  readonly environment: string;
  readonly key: string;
}

interface AutomationStateListOptions {
  readonly automationName: string;
  readonly environment: string;
}

type PlatformTimeoutGrantRecord = StoredTimeoutGrant;

interface SetTimeoutGrantOptions {
  readonly automationName: string;
  readonly environment: string;
  readonly maxTimeoutMs: number;
  readonly note?: string | null;
}

interface TimeoutGrantKeyOptions {
  readonly automationName: string;
  readonly environment: string;
}

export interface CreatePlatformServicesOptions {
  readonly workerRegistry?: Pick<
    import("@swizzle/db").WorkerRegistry,
    "list" | "placement" | "close"
  >;
  readonly dashboardStore?: DashboardStore;
  readonly artifactsDirectory?: string;
  readonly rateLimiter?: RateLimiter;
  readonly store?: ControlPlaneStore;
  readonly valkeyUrl?: string;
}

export interface StartPlatformWorkerOptions {
  readonly allowLocalHttp?: boolean;
  readonly apiUrl: string;
  readonly credential: import("./worker-credential.js").WorkerCredentialSource;
  readonly concurrency?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly logger?: PlatformLogger;
  /** What this host can run, reported with every heartbeat; see `collectWorkerCapabilities`. */
  readonly capabilities: import("@swizzle/db").WorkerCapabilities;
}

export interface PlatformLogger {
  child?(bindings: Record<string, unknown>): PlatformLogger;
  debug(...args: readonly unknown[]): void;
  error(...args: readonly unknown[]): void;
  info(...args: readonly unknown[]): void;
  warn(...args: readonly unknown[]): void;
}

export interface PlatformWorkerController {
  close(): Promise<void>;
}

export interface ReconcileQueuedRunsOptions {
  readonly environment?: string;
}

export interface ReconcileQueuedRunsResult {
  readonly requeuedCount: number;
  readonly requeuedRunIds: readonly string[];
  readonly skippedExistingJobIds: readonly string[];
}

interface BeginConnectionAuthorizationOptions {
  /** New client id to store on the connection (omit to reuse existing / reuseFrom). */
  readonly clientId?: string | undefined;
  /** New client secret to store on the connection (omit to reuse existing / reuseFrom). */
  readonly clientSecret?: string | undefined;
  /** Whoever creates the connection, a person or a service account, gets a manage grant on it. */
  readonly creator?: Subject | undefined;
  readonly name: string;
  readonly place: CredentialPlace;
  readonly provider?: string | undefined;
  readonly providerConfig?: Record<string, unknown> | null | undefined;
  /** The id of the connection the caller checked and re-authorizes, or null for a new one. */
  readonly reauthorizes: string | null;
  /** Copy client credentials from an existing connection instead of re-entering them. */
  readonly reuseFrom?: string | undefined;
  readonly publicUrl: string;
  readonly scopes?: readonly string[];
}

interface CompleteConnectionCallbackOptions {
  readonly code?: string | undefined;
  readonly providerError?: string | undefined;
  readonly providerFromPath: string;
  readonly state?: string | undefined;
}

/** Credential lookup, grants and shares; the API checks the caller's rights before it calls them. */
type PlatformCredentials = Pick<
  ControlPlaneStore,
  | "acceptCredentialShare"
  | "credentialAccess"
  | "findCredential"
  | "findDeploymentCredentials"
  | "listCredentialShares"
  | "offerCredentialShare"
  | "removeCredentialGrant"
  | "removeCredentialShare"
  | "setCredentialGrant"
>;

export interface PlatformServices {
  beginConnectionAuthorization(
    options: BeginConnectionAuthorizationOptions,
  ): Promise<BeginConnectionAuthorizationResult>;
  cancelPlatformRun(runId: string): Promise<CancelRunResult>;
  completeConnectionCallback(
    options: CompleteConnectionCallbackOptions,
  ): Promise<ConnectionCallbackResult>;
  /** Deletes the connection with this id and revokes its tokens; false when it is gone. */
  deleteConnection(connectionId: string): Promise<boolean>;
  getConnection(name: string, place: CredentialPlace): Promise<PlatformConnectionRecord | null>;
  listConnections(
    environment: string,
    projectIds: readonly string[] | "all",
  ): Promise<readonly PlatformConnectionRecord[]>;
  testConnection(name: string, place: CredentialPlace): Promise<TestConnectionResult>;
  readonly credentials: PlatformCredentials;
  checkReadiness(): Promise<PlatformReadinessReport>;
  close(): Promise<void>;
  createNotificationRule(
    options: CreateNotificationRuleOptions,
  ): Promise<PlatformNotificationRuleRecord>;
  deleteNotificationRule(ruleId: string): Promise<boolean>;
  /** Deletes the secret with this id; false when it is gone. */
  deleteSecret(secretId: string): Promise<boolean>;
  findSecretDeclarationCollisions(
    input: CredentialPlace & {
      readonly excludeAutomationSlug?: string;
      readonly secretNames: readonly string[];
    },
  ): Promise<readonly SecretDeclarationCollision[]>;
  deployAutomationToPlatform(options: PlatformDeployOptions): Promise<PlatformApplyResult>;
  /**
   * Every check `deployAutomationToPlatform` makes before it builds, without building or
   * committing: it throws the refusal apply would throw, and otherwise says what apply would do
   * and what the workers serving the project say about it (deployment-check.ts).
   */
  checkDeployment(options: PlatformDeployOptions): Promise<PlatformDeploymentCheck>;
  /** The live automation's id and project, or null when none has this name. */
  findAutomation(automationName: string): Promise<AutomationOwner | null>;
  /** See ControlPlaneStore.moveAutomation; refuses while a trigger in any environment is active. */
  moveAutomation(automationName: string, projectId: string): Promise<MovedAutomation>;
  enqueuePlatformRun(options: EnqueuePlatformRunOptions): Promise<PlatformRunRecord>;
  getAutomationDeployment(
    automationName: string,
    environment: string,
  ): Promise<PlatformDeploymentRecord>;
  getAutomationTrigger(automationName: string, environment: string): Promise<PlatformTriggerRecord>;
  getDeploymentById(deploymentId: string): Promise<PlatformDeploymentRecord>;
  getLatestMaintenanceRun(environment: string): Promise<PlatformMaintenanceRunRecord | null>;
  getPlatformRun(runId: string): Promise<PlatformRunDetail>;
  listAutomationState(
    options: AutomationStateListOptions,
  ): Promise<readonly StoredAutomationStateEntry[]>;
  getAutomationStateValue(
    options: AutomationStateKeyOptions,
  ): Promise<StoredAutomationStateEntry | null>;
  setAutomationStateValue(options: AutomationStateSetOptions): Promise<StoredAutomationStateEntry>;
  deleteAutomationStateValue(options: AutomationStateKeyOptions): Promise<boolean>;
  setAutomationTimeoutGrant(options: SetTimeoutGrantOptions): Promise<PlatformTimeoutGrantRecord>;
  getAutomationTimeoutGrant(
    options: TimeoutGrantKeyOptions,
  ): Promise<PlatformTimeoutGrantRecord | null>;
  deleteAutomationTimeoutGrant(options: TimeoutGrantKeyOptions): Promise<boolean>;
  listAutomationTimeoutGrants(environment: string): Promise<readonly PlatformTimeoutGrantRecord[]>;
  getSecret(name: string, place: CredentialPlace): Promise<SecretView | null>;
  listAutomationDeploymentAuditEvents(
    automationName: string,
    environment: string,
    limit?: number,
  ): Promise<readonly AuditEventOf<"deployment">[]>;
  listAutomationDeployments(
    automationName: string,
    environment: string,
  ): Promise<readonly StoredDeployment[]>;
  listAutomationTriggerAuditEvents(
    automationName: string,
    environment: string,
    limit?: number,
  ): Promise<readonly AuditEventOf<"trigger">[]>;
  listNotificationDeliveries(
    options: ListNotificationDeliveriesOptions,
  ): Promise<readonly PlatformNotificationDeliveryRecord[]>;
  /** The rules in an environment; with `userId`, only that person's. */
  listNotificationRules(
    environment: string,
    userId?: string,
  ): Promise<readonly PlatformNotificationRuleRecord[]>;
  getNotificationRule(ruleId: string): Promise<PlatformNotificationRuleRecord | null>;
  listQueueMetricSamples(
    environment: string,
    limit?: number,
  ): Promise<readonly PlatformQueueMetricSampleRecord[]>;
  listSecrets(
    environment: string,
    projectIds: readonly string[] | "all",
  ): Promise<readonly SecretView[]>;
  /** Enqueues the API checks that are due; returns how many it enqueued. */
  enqueueDueApiChecks(options: {
    readonly environment: string;
    readonly now?: Date;
  }): Promise<number>;
  materializeDueCronRuns(
    options: MaterializeCronRunsOptions,
  ): Promise<readonly PlatformRunRecord[]>;
  pauseAutomationTrigger(
    automationName: string,
    environment: string,
  ): Promise<PlatformTriggerRecord>;
  reconcileQueuedRuns(options: ReconcileQueuedRunsOptions): Promise<ReconcileQueuedRunsResult>;
  /** Resolves the `waitForEvent` a run waits for at a step. */
  resolveRunEvent(options: ResolveRunEventOptions): Promise<ResolveWaitingEventRunResult>;
  /** Decides the approval a run waits for at a step (run-lifecycle.ts decideWaitingApproval). */
  decideApproval(options: DecideApprovalOptions): Promise<ResolveWaitingEventRunResult>;
  /** False when the approval was decided, timed out or reassigned meanwhile. */
  reassignApproval(options: ReassignApprovalOptions): Promise<boolean>;
  /** The person (by email) or team (by name) an approval may be assigned to; null when unknown. */
  resolveApprovalAssignee(request: AssigneeRequest): Promise<ApprovalAssignee | null>;
  /** The wait a public approval or event link resolves, checked against the run's current state. */
  findWaitByLink(options: WaitLinkOptions): Promise<WaitLinkLookupResult>;
  resumeDueWaitingRuns(options: ResumeDueWaitingRunsOptions): Promise<ResumeDueWaitingRunsResult>;
  resumeAutomationTrigger(
    automationName: string,
    environment: string,
  ): Promise<PlatformTriggerRecord>;
  deleteAutomation(options: DeleteAutomationOptions): Promise<DeleteAutomationResultRecord>;
  countProjectContents(projectId: string): Promise<ProjectContentCounts | null>;
  /** Deletes a project and, as asked, moves or deletes its contents; see ControlPlaneStore. */
  deleteProject(input: DeleteProjectInput): Promise<DeleteProjectResultRecord>;
  rollbackDeployment(options: RollbackOptions): Promise<PlatformDeploymentRecord>;
  runMaintenance(options: RunMaintenanceOptions): Promise<MaintenanceCycleResult>;
  /** Starts a run by hand; it reads as `manual`, never as a delivery. See startManualRun. */
  startManualRun(options: StartManualRunOptions): Promise<ManualTriggerRunRecord>;
  triggerWebhookByPath(options: TriggerWebhookByPathOptions): Promise<PlatformRunRecord>;
  updateNotificationRule(
    options: UpdateNotificationRuleOptions,
  ): Promise<PlatformNotificationRuleRecord | null>;
  upsertSecret(
    name: string,
    value: string,
    place: CredentialPlace,
    options?: {
      /** Whoever creates the secret, a person or a service account, gets a manage grant on it. */
      readonly creator?: Subject;
      /** The secret the write may replace, as `UpsertSecretInput.replaces` describes. */
      readonly replaces?: string | null;
    },
  ): Promise<PlatformSecretRecord>;
}
