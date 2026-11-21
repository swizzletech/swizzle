import type {
  AccessRefusal,
  ApprovalAssignee,
  AuditEvent,
  AutomationFolder,
  CredentialAccessView,
  CredentialHolder,
  CredentialKind,
  CredentialRight,
  CredentialRightSource,
  CredentialShare,
  DashboardApiCheck,
  DashboardAttentionItem,
  DashboardAutomationRef,
  DashboardAutomationSource,
  DashboardDeploymentChange,
  DashboardHourCounts,
  DashboardPlatformProblem,
  DashboardRunDetail,
  DashboardRunListItem,
  DashboardRunStep,
  DashboardStepReach,
  DashboardTimetable,
  DashboardTriggerSummary,
  DEFAULT_PROJECT_ID as DbDefaultProjectId,
  EnvironmentHold,
  Holder,
  InstanceRole,
  ProjectAccessView,
  ProjectContentCounts,
  ProjectHolder,
  ProjectRef,
  ProjectRole,
  RUN_STATUS_PHASE,
  ServiceAccountView,
  SharedCredential,
  ShareRole,
  StoredNotificationRule,
  StoredTeam,
  Subject,
  SubjectReference,
  TokenView,
  VisibleProject,
  WorkerGrants,
} from "@swizzle/db";
import type {
  ApiErrorResponse,
  AutomationDetailResponse,
  AutomationSummaryResponse,
  ConnectionResponse,
  ConnectionsResponse,
  CreatedTokenResponse,
  DeploymentSummaryResponse,
  InvitationOfferResponse,
  OverviewResponse,
  PeopleResponse,
  SecretsResponse,
  TriggerSummaryResponse,
  TwoFactorEnrollmentResponse,
} from "@swizzle/runtime/http-contract";

export type RunStatus = DashboardRunListItem["status"];
export type RunState = DashboardRunListItem["state"];

const RUN_PHASE: typeof RUN_STATUS_PHASE = {
  queued: "open",
  running: "open",
  waiting: "open",
  succeeded: "finished",
  failed: "finished",
  "dead-lettered": "finished",
};

export function isOpenRun(status: RunStatus): boolean {
  return RUN_PHASE[status] === "open";
}

export type TriggerType = DashboardTriggerSummary["triggerType"];
export type NotificationRule = StoredNotificationRule;

export type { InstanceRole, ProjectRole, ShareRole, Subject };

export type Person = PeopleResponse["users"][number];

export type InvitationOffer = InvitationOfferResponse;

export type TwoFactorEnrollment = TwoFactorEnrollmentResponse;

export type { ProjectRef };

export type TokenScope = TokenView["scope"];

export interface ScopeInput {
  readonly environments?: readonly string[];
  readonly projects?: readonly string[];
  readonly role?: ProjectRole;
}

export type ServiceAccount = ServiceAccountView;

export type Team = StoredTeam;

export type SubjectRef = SubjectReference;

export type GrantPlaceRef =
  | { readonly on: "project" }
  | { readonly on: "automation"; readonly automation: string }
  | { readonly on: "environment"; readonly environment: string };

export type AccessGrant = ProjectAccess["grants"][number];

export type ProjectAccess = ProjectAccessView;

export type { AuditEvent };

export type CreatedApiToken = CreatedTokenResponse;

export type { AutomationFolder };

export type SecretMetadata = SecretsResponse["secrets"][number];

export interface CredentialRef {
  readonly kind: CredentialKind;
  readonly name: string;
  readonly projectId: string;
}

export type {
  CredentialAccessView,
  CredentialHolder,
  CredentialRight,
  CredentialRightSource,
  CredentialShare,
  EnvironmentHold,
  Holder,
  ProjectHolder,
  SharedCredential,
};

export const DEFAULT_PROJECT_ID: typeof DbDefaultProjectId = "00000000-0000-4000-8000-000000000001";

export type ProjectContentsChoice =
  | { readonly kind: "move"; readonly to: string }
  | { readonly kind: "delete" };

export type { ProjectContentCounts };

export type Project = VisibleProject;
export type TriggerSummary = TriggerSummaryResponse;

export type ConnectionMetadata = ConnectionResponse;

export type ListedConnection = ConnectionsResponse["connections"][number];

export type RuntimeReadiness = DeploymentSummaryResponse["readiness"];

export type RunListItem = DashboardRunListItem;

export type AutomationSummary = AutomationSummaryResponse;
export type AutomationDetail = AutomationDetailResponse;

export type Overview = OverviewResponse;
export type AttentionItem = DashboardAttentionItem;
export type ApiCheck = DashboardApiCheck;
export type PlatformProblem = DashboardPlatformProblem;
export type DeploymentChange = DashboardDeploymentChange;
export type Timetable = DashboardTimetable;
export type HourCounts = DashboardHourCounts;
export type AutomationRef = DashboardAutomationRef;

export type AutomationSource = DashboardAutomationSource;
export type StepReach = DashboardStepReach;
export type RunDetail = DashboardRunDetail;
export type Assignee = ApprovalAssignee;
export type RunStep = DashboardRunStep;

export type ApiErrorCode = ApiErrorResponse["error"];

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: ApiErrorCode,
    public readonly details?: unknown,
    public readonly fixCommand?: string,
    public readonly retryAfter?: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface InstanceEnvironments {
  readonly defaultEnvironment: string;
  readonly names: readonly string[];
}

export type {
  ExplainedPlacement,
  WorkerEnrollment,
  WorkerListing,
  WorkerStatus,
} from "@swizzle/db";
export type {
  ApiErrorResponse,
  ApprovalAssigneeResponse,
  AssignAutomationFolderResponse,
  AuditedRoute,
  AuditResponse,
  AuthorizeConnectionResponse,
  AuthStatusResponse,
  AutomationDetailResponse,
  AutomationFolderResponse,
  AutomationFoldersResponse,
  AutomationMermaidResponse,
  AutomationReadmeResponse,
  AutomationSourceResponse,
  AutomationsResponse,
  CancelRunResponse,
  ConnectionsResponse,
  CreatedTokenResponse,
  CreateProjectResponse,
  CreateServiceAccountResponse,
  CreateTeamResponse,
  CredentialAccessResponse,
  CredentialShareResponse,
  CredentialSharesResponse,
  DashboardRunResponse,
  DeleteProjectResponse,
  DeleteServiceAccountResponse,
  DeleteTeamResponse,
  DeploymentResponse,
  DirectoryResponse,
  EnvironmentProtectionResponse,
  EnvironmentsResponse,
  HealthResponse,
  IdentityResponse,
  InvitationOfferResponse,
  InvitationsResponse,
  NoContentResponse,
  NotificationDeliveriesResponse,
  NotificationRuleResponse,
  NotificationRulesResponse,
  OperationsSummaryResponse,
  OverviewResponse,
  PeopleResponse,
  PersonResponse,
  ProjectAccessResponse,
  ProjectContentsResponse,
  ProjectsResponse,
  RemoveGrantResponse,
  ResetLinkResponse,
  ResumeRunResponse,
  RunDiagnosisResponse,
  RunStepsResponse,
  RunsResponse,
  SecretsResponse,
  SentInvitationResponse,
  ServiceAccountsResponse,
  SessionsResponse,
  SetGrantResponse,
  SetSecretResponse,
  SharedCredentialsResponse,
  SignInResponse,
  StepReachResponse,
  TeamMembershipResponse,
  TeamsResponse,
  TestConnectionResponse,
  TokenResponse,
  TokensResponse,
  TriggerRunResponse,
  TriggerStatusResponse,
  TwoFactorEnrollmentResponse,
  TwoFactorResponse,
  WorkerEnrollmentResponse,
  WorkerResponse,
  WorkersResponse,
} from "@swizzle/runtime/http-contract";
export type { AccessRefusal, WorkerGrants };
