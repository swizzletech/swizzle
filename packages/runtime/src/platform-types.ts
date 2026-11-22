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
import type { RunnerImageChecks } from "./runner-image-checks.js";
import type { WaitLinkKind } from "./wait-links.js";

export type PlatformRunRecord = StoredRun;

export type ResolveWaitingEventRunResult =
  | { readonly status: "resolved"; readonly run: PlatformRunRecord }
  | { readonly status: "not-waiting"; readonly run: PlatformRunRecord }
  | { readonly status: "key-mismatch"; readonly run: PlatformRunRecord };

export interface OpenWaitRecord {
  readonly automationName: string;
  readonly details: unknown | null;
  readonly expiresAt: string;
  readonly runId: string;
  readonly stepKey: string;
}

export type WaitLinkLookupResult =
  | { readonly status: "open"; readonly target: AuditTarget; readonly wait: OpenWaitRecord }
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
  readonly expectedSourceHash?: string;
  readonly force?: boolean;
  readonly project?: (automation: {
    readonly automationSlug: string;
    readonly current: AutomationOwner | null;
  }) => Promise<string>;
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
  readonly userId: string;
  readonly projectId: string;
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
  readonly createdSince?: string;
  readonly environment: string;
  readonly eventType?: NotificationDeliveryEventType;
  readonly limit?: number;
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
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  readonly creator?: Subject | undefined;
  readonly name: string;
  readonly place: CredentialPlace;
  readonly provider?: string | undefined;
  readonly providerConfig?: Record<string, unknown> | null | undefined;
  readonly reauthorizes: string | null;
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
  readonly runnerImageChecks: RunnerImageChecks;
  beginConnectionAuthorization(
    options: BeginConnectionAuthorizationOptions,
  ): Promise<BeginConnectionAuthorizationResult>;
  cancelPlatformRun(runId: string): Promise<CancelRunResult>;
  completeConnectionCallback(
    options: CompleteConnectionCallbackOptions,
  ): Promise<ConnectionCallbackResult>;
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
  deleteSecret(secretId: string): Promise<boolean>;
  findSecretDeclarationCollisions(
    input: CredentialPlace & {
      readonly excludeAutomationSlug?: string;
      readonly secretNames: readonly string[];
    },
  ): Promise<readonly SecretDeclarationCollision[]>;
  deployAutomationToPlatform(options: PlatformDeployOptions): Promise<PlatformApplyResult>;
  checkDeployment(options: PlatformDeployOptions): Promise<PlatformDeploymentCheck>;
  findAutomation(automationName: string): Promise<AutomationOwner | null>;
  moveAutomation(automationName: string, projectId: string): Promise<MovedAutomation>;
  enqueuePlatformRun(options: EnqueuePlatformRunOptions): Promise<PlatformRunRecord>;
  getAutomationDeployment(
    automationName: string,
    environment: string,
  ): Promise<PlatformDeploymentRecord>;
  getAutomationTrigger(automationName: string, environment: string): Promise<PlatformTriggerRecord>;
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
  resolveRunEvent(options: ResolveRunEventOptions): Promise<ResolveWaitingEventRunResult>;
  decideApproval(options: DecideApprovalOptions): Promise<ResolveWaitingEventRunResult>;
  reassignApproval(options: ReassignApprovalOptions): Promise<boolean>;
  resolveApprovalAssignee(request: AssigneeRequest): Promise<ApprovalAssignee | null>;
  findWaitByLink(options: WaitLinkOptions): Promise<WaitLinkLookupResult>;
  resumeDueWaitingRuns(options: ResumeDueWaitingRunsOptions): Promise<ResumeDueWaitingRunsResult>;
  resumeAutomationTrigger(
    automationName: string,
    environment: string,
  ): Promise<PlatformTriggerRecord>;
  deleteAutomation(options: DeleteAutomationOptions): Promise<DeleteAutomationResultRecord>;
  listAutomationChainDependents(
    automationName: string,
  ): ReturnType<ControlPlaneStore["listAutomationChainDependents"]>;
  countProjectContents(projectId: string): Promise<ProjectContentCounts | null>;
  deleteProject(input: DeleteProjectInput): Promise<DeleteProjectResultRecord>;
  rollbackDeployment(options: RollbackOptions): Promise<PlatformDeploymentRecord>;
  runMaintenance(options: RunMaintenanceOptions): Promise<MaintenanceCycleResult>;
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
      readonly creator?: Subject;
      readonly replaces?: string | null;
    },
  ): Promise<PlatformSecretRecord>;
}
