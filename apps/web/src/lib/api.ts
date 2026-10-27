// The API as the dashboard reads it: the response types, ApiError and the run phases. The types
// come type-only from @swizzle/db and @swizzle/runtime/http-contract; this is the dashboard's one
// import of a server package. The calls live in lib/api/, one module per resource, and
// lib/api/client.ts binds them to an environment.

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
  DashboardPlatformProblem,
  DashboardRunDetail,
  DashboardRunListItem,
  DashboardRunStep,
  DashboardStepReach,
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

// The run phases of @swizzle/db, which this seam may import as types only. Typed as the package's
// table, so a status that changes phase or a new status fails the build until this copy agrees.
const RUN_PHASE: typeof RUN_STATUS_PHASE = {
  queued: "open",
  running: "open",
  waiting: "open",
  succeeded: "finished",
  failed: "finished",
  "dead-lettered": "finished",
};

/** A run that is still queued, running or waiting; the dashboard keeps polling it. */
export function isOpenRun(status: RunStatus): boolean {
  return RUN_PHASE[status] === "open";
}

export type TriggerType = DashboardTriggerSummary["triggerType"];
export type NotificationRule = StoredNotificationRule;

export type { InstanceRole, ProjectRole, ShareRole, Subject };

/** GET /users: everyone with an account on this instance. */
export type Person = PeopleResponse["users"][number];

/** POST /auth/invitation: what the link in an invitation mail offers its recipient. */
export type InvitationOffer = InvitationOfferResponse;

export type TwoFactorEnrollment = TwoFactorEnrollmentResponse;

export type { ProjectRef };

/**
 * The most a token may do, fixed when it is minted: `projects` and `environments` null mean every
 * one its holder reaches. A personal token of role admin with neither limit acts with all of its
 * person's rights.
 */
export type TokenScope = TokenView["scope"];

/** What a request names a scope with: projects by id or slug; a missing field limits nothing. */
export interface ScopeInput {
  readonly environments?: readonly string[];
  readonly projects?: readonly string[];
  readonly role?: ProjectRole;
}

/** GET /projects/:project/service-accounts: an account with its grants and its tokens. */
export type ServiceAccount = ServiceAccountView;

export type Team = StoredTeam;

/** Who a grant names, as the API takes it: a person, team or service account by id. */
export type SubjectRef = SubjectReference;

/** Where a grant applies: the whole project, one automation (by slug) or one environment. */
export type GrantPlaceRef =
  | { readonly on: "project" }
  | { readonly on: "automation"; readonly automation: string }
  | { readonly on: "environment"; readonly environment: string };

/** A grant in a project, with whom it names. */
export type AccessGrant = ProjectAccess["grants"][number];

/** GET /projects/:project/access, for the project's admins. */
export type ProjectAccess = ProjectAccessView;

export type { AuditEvent };

export type CreatedApiToken = CreatedTokenResponse;

export type { AutomationFolder };

/** A secret as a list shows it, with what the signed-in person may do with it. */
export type SecretMetadata = SecretsResponse["secrets"][number];

/** A secret or connection by the project that owns it, in the dashboard's environment. */
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

/** The project a fresh instance starts with; the API refuses to delete it. */
export const DEFAULT_PROJECT_ID: typeof DbDefaultProjectId = "00000000-0000-4000-8000-000000000001";

/** Where a deleted project's automations, credentials and runs go: `to` is a project slug. */
export type ProjectContentsChoice =
  | { readonly kind: "move"; readonly to: string }
  | { readonly kind: "delete" };

export type { ProjectContentCounts };

/**
 * GET /projects: a project the signed-in person sees, with their role in it as such and the
 * environments it protects. Owners and admins see every project, as admin.
 */
export type Project = VisibleProject;
export type TriggerSummary = TriggerSummaryResponse;

export type ConnectionMetadata = ConnectionResponse;

/** A connection as a list shows it, with what the signed-in person may do with it. */
export type ListedConnection = ConnectionsResponse["connections"][number];

/** A deployment's readiness; the active one also counts its unset secrets and broken connections. */
export type RuntimeReadiness = DeploymentSummaryResponse["readiness"];

export type RunListItem = DashboardRunListItem;

export type AutomationSummary = AutomationSummaryResponse;
export type AutomationDetail = AutomationDetailResponse;

export type Overview = OverviewResponse;
export type AttentionItem = DashboardAttentionItem;
export type ApiCheck = DashboardApiCheck;
export type PlatformProblem = DashboardPlatformProblem;
export type DeploymentChange = DashboardDeploymentChange;
export type AutomationRef = DashboardAutomationRef;

export type AutomationSource = DashboardAutomationSource;
export type StepReach = DashboardStepReach;
export type RunDetail = DashboardRunDetail;
export type Assignee = ApprovalAssignee;
export type RunStep = DashboardRunStep;

/** A code the API names a failure with; comparing ApiError.code with any other fails the build. */
export type ApiErrorCode = ApiErrorResponse["error"];

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: ApiErrorCode,
    public readonly details?: unknown,
    public readonly fixCommand?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The environments an instance lists. The API puts its default, its SWIZZLE_ENVIRONMENT, first. */
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
