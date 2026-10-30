// The HTTP contract of the Swizzle API: what each route answers and the bodies its clients send.
// The API names these types in Fastify Reply generics; the CLI and dashboard read responses through
// them, so a changed shape fails every consumer's type check. Import it as
// @swizzle/runtime/http-contract. Browser consumers import types only.
//
// The dashboard type-checks everything this module reaches, so it names records only: @swizzle/db
// and the runtime's record modules, never platform-types.ts or a database or queue client. `just
// check` holds that line; a record a response needs goes in platform-records.ts.

import type {
  AccessRefusal,
  ApprovalAssignee,
  AuditEvent,
  AuditEventOf,
  AuthActionResult,
  AuthSessionMetadata,
  AuthUser,
  AutomationFolder,
  ConnectionView,
  CredentialRight,
  CredentialShare,
  DashboardAutomationDetail,
  DashboardAutomationRefusals,
  DashboardAutomationSummary,
  DashboardDeploymentSummary,
  DashboardOverview,
  DashboardRunStep,
  DashboardRunsResult,
  DashboardTriggerSummary,
  InstanceRole,
  PeopleDirectory,
  PlacementWorker,
  PlatformRunStatus,
  ProjectRef,
  ProjectRole,
  RegisteredWorker,
  SecretView,
  ServiceAccountView,
  SharedCredential,
  SignInResult,
  StoredAutomationStateEntry,
  StoredDeployment,
  StoredEnvironment,
  StoredNotificationDelivery,
  StoredNotificationRule,
  StoredSecret,
  StoredTeam,
  StoredTimeoutGrant,
  StoredTrigger,
  TokenView,
  TwoFactorEnrollment,
  VisibleProject,
  WorkerGroup,
  WorkerListing,
} from "@swizzle/db";

import type {
  BeginConnectionAuthorizationResult,
  CancelRunResult,
  DeleteAutomationResultRecord,
  DeleteProjectResultRecord,
  Diagnosis,
  ManualTriggerRunRecord,
  PlatformApplyResult,
  PlatformDeploymentCheck,
  PlatformDeploymentRecord,
  PlatformReadinessReport,
  PlatformRunDetail,
  PlatformSecretStatusRecord,
  RuntimeReadinessReport,
  TestConnectionResult,
} from "./platform-records.js";

/** A deployment as apply and rollback answer it. */
export type DeploymentResponse = Pick<
  PlatformDeploymentRecord,
  | "artifactRootPath"
  | "automationName"
  | "buildSnapshot"
  | "config"
  | "connectionHealth"
  | "deployedAt"
  | "deploymentId"
  | "readiness"
  | "runtimeSnapshot"
  | "secretHealth"
  | "seq"
  | "sourceHash"
  | "triggerType"
  | "version"
  | "versionId"
> & {
  readonly vars: PlatformDeploymentRecord["config"]["vars"];
};

/** GET /runs/:runId. `dashboardUrl` is the run's panel; null without SWIZZLE_DASHBOARD_ORIGIN. */
export type RunResponse = PlatformRunDetail & { readonly dashboardUrl: string | null };

/** GET /runs/:runId/diagnosis: the record `swizzle diagnose` prints. */
export type RunDiagnosisResponse = Diagnosis;

/** A deployment in the dashboard's read model, judged by the API against the live workers. */
export type DeploymentSummaryResponse = DashboardDeploymentSummary & {
  readonly readiness: RuntimeReadinessReport;
};
/** A cron's next run, or the environment no live scheduler serves; null without a next time. */
export type CronNextRun =
  | { readonly kind: "at"; readonly at: string }
  | { readonly kind: "unserved"; readonly environment: string }
  | null;

/** New scaffolds use this namespace, which the public listener forwards without rewriting. */
export const WEBHOOK_PATH_PREFIX = "/hooks";

/** Only cron triggers have a next run to judge against the live schedulers. */
export type JudgedTriggerSummary = Omit<DashboardTriggerSummary, "triggerType" | "nextRunAt"> &
  (
    | { readonly triggerType: "cron"; readonly nextRun: CronNextRun }
    | { readonly triggerType: "chain" }
    | { readonly triggerType: "webhook" }
  );
/**
 * A trigger with the URL its webhook answers at: /hooks/ uses the public base and root paths
 * use the API base. Null for another trigger or where the API does not know where it is reached.
 */
export type TriggerSummaryResponse = JudgedTriggerSummary & {
  readonly webhookUrl: string | null;
};
/** A judged record whose trigger carries its webhook URL. */
export type WithWebhookUrl<T extends { readonly trigger: JudgedTriggerSummary | null }> = Omit<
  T,
  "trigger"
> & { readonly trigger: TriggerSummaryResponse | null };
/** An automation with its active deployment and its trigger judged against the live services. */
export type JudgedAutomationSummary = Omit<
  DashboardAutomationSummary,
  "activeDeployment" | "trigger"
> & {
  readonly activeDeployment: DeploymentSummaryResponse;
  readonly trigger: JudgedTriggerSummary | null;
};
export type AutomationSummaryResponse = WithWebhookUrl<JudgedAutomationSummary>;
/** The automation detail with every deployment and its trigger judged against the live services. */
export type JudgedAutomationDetail = Omit<
  DashboardAutomationDetail,
  "activeDeployment" | "deploymentHistory" | "trigger"
> & {
  readonly activeDeployment: DeploymentSummaryResponse;
  readonly deploymentHistory: readonly DeploymentSummaryResponse[];
  readonly trigger: JudgedTriggerSummary | null;
};
/**
 * GET /dashboard/overview, with why the caller may not deploy a new automation that names no
 * project, which lands in the default project; null where they may. The empty Overview offers the
 * steps to a first one only then.
 */
export type OverviewResponse = DashboardOverview & {
  readonly deploy: AccessRefusal | null;
};
/** GET /dashboard/automations/:name, with the controls the viewer's role refuses. */
export type AutomationDetailResponse = WithWebhookUrl<JudgedAutomationDetail> & {
  readonly refusals: DashboardAutomationRefusals;
};

export type DeleteProjectResponse =
  | { readonly changed: false; readonly project: string }
  | ({
      readonly changed: true;
      readonly project: string;
    } & DeleteProjectResultRecord);

/**
 * A connection as every route answers it. The client secret, provider config and token material
 * stay server-side; the client id is not confidential and tells operators which app it uses.
 */
export type ConnectionResponse = Pick<
  ConnectionView,
  | "accessTokenExpiresAt"
  | "authorizationPending"
  | "clientId"
  | "createdAt"
  | "environment"
  | "id"
  | "lastErrorAt"
  | "lastErrorCode"
  | "lastRefreshedAt"
  | "name"
  | "project"
  | "provider"
  | "scopes"
  | "status"
  | "tokenVersion"
  | "updatedAt"
>;
export type AuthorizeConnectionResponse = Omit<BeginConnectionAuthorizationResult, "connection"> & {
  readonly connection: ConnectionResponse;
};
export type TestConnectionResponse = Omit<TestConnectionResult, "connection"> & {
  readonly connection: ConnectionResponse;
};

export interface ProjectsResponse {
  readonly projects: readonly VisibleProject[];
}
export interface TeamsResponse {
  readonly teams: readonly StoredTeam[];
}
export type DirectoryResponse = PeopleDirectory;
export interface PeopleResponse {
  readonly users: readonly Pick<
    AuthUser,
    "email" | "id" | "name" | "role" | "suspended" | "twoFactorEnabled"
  >[];
}
export interface ServiceAccountsResponse {
  readonly serviceAccounts: readonly ServiceAccountView[];
}
export interface ResetLinkResponse {
  readonly url: string;
  readonly expiresAt: string;
}
export interface HealthResponse {
  readonly service: string;
  readonly status: string;
  readonly version: string;
}
export type ReadyResponse = Pick<PlatformReadinessReport, "checks"> & {
  readonly app: string;
  readonly service: string;
  readonly status: string;
  readonly version: string;
};
export interface EnvironmentsResponse {
  readonly defaultEnvironment: string;
  readonly environments: readonly StoredEnvironment[];
}
/** GET /secrets: each secret with what the caller may do with it. */
export interface SecretsResponse {
  readonly environment: string;
  /** Each secret with the caller's right on it and its project, since a list can span several. */
  readonly secrets: readonly (SecretView & {
    readonly right: CredentialRight | null;
  })[];
}
export type SecretResponse = SecretView;
export type SetSecretResponse = StoredSecret & { readonly warnings: readonly string[] };
export interface TimeoutGrantsResponse {
  readonly environment: string;
  readonly grants: readonly StoredTimeoutGrant[];
}
export interface TimeoutGrantResponse {
  readonly automationName: string;
  readonly environment: string;
  readonly grant: StoredTimeoutGrant | null;
}
export type SetTimeoutGrantResponse = Omit<TimeoutGrantResponse, "grant"> & {
  readonly grant: StoredTimeoutGrant;
};
export interface NotificationRulesResponse {
  readonly environment: string;
  readonly rules: readonly StoredNotificationRule[];
}
export interface NotificationDeliveriesResponse {
  readonly environment: string;
  readonly deliveries: readonly StoredNotificationDelivery[];
}
export interface ConnectionsResponse {
  readonly redirectBaseUrl: string | null;
  readonly environment: string;
  readonly connections: readonly (ConnectionResponse & {
    readonly right: CredentialRight | null;
  })[];
}
export interface AutomationsResponse {
  readonly environment: string;
  readonly automations: readonly AutomationSummaryResponse[];
}
export interface DeploymentsResponse {
  readonly automationName: string;
  readonly environment: string;
  readonly deployments: readonly StoredDeployment[];
}
export interface AutomationSecretsResponse {
  readonly automationName: string;
  readonly environment: string;
  readonly secrets: readonly PlatformSecretStatusRecord[];
}
export interface StateListResponse {
  readonly automationName: string;
  readonly environment: string;
  readonly state: readonly StoredAutomationStateEntry[];
}
export interface StateValueResponse {
  readonly automationName: string;
  readonly environment: string;
  readonly key: string;
  readonly state: StoredAutomationStateEntry | null;
}
export type SetStateResponse = Omit<StateValueResponse, "state" | "key"> & {
  readonly state: StoredAutomationStateEntry;
};
export interface DeleteStateResponse {
  readonly automationName: string;
  readonly environment: string;
  readonly key: string;
  readonly deleted: boolean;
}
export type TriggerRunResponse = Pick<
  ManualTriggerRunRecord,
  "deploymentId" | "queuedAt" | "runId" | "status" | "warning"
>;
export type TriggerStatusResponse = StoredTrigger;
export type RunsResponse = DashboardRunsResult;
export type CancelRunResponse = CancelRunResult;
export interface ResumeRunResponse {
  readonly resumed: true;
  readonly runId: string;
  readonly stepKey: string;
}
export interface RunLogsResponse {
  readonly runId: string;
  readonly chunks: readonly {
    readonly chunk: string;
    readonly cursor: string;
    readonly stream: "stderr" | "stdout";
  }[];
  readonly cursor: string;
  readonly status: PlatformRunStatus;
  readonly terminal: boolean;
}
export interface WorkerGroupsResponse {
  readonly groups: readonly WorkerGroup[];
}
export interface WorkersResponse {
  readonly workers: readonly WorkerListing[];
}
/** POST /deployments. `webhookUrl` as in `TriggerSummaryResponse`. */
export type ApplyResponse = DeploymentResponse &
  Pick<PlatformApplyResult, "action" | "changes" | "message"> & {
    readonly warnings: readonly string[];
    readonly webhookUrl: string | null;
  };
/**
 * POST /deployment-checks: what apply would do after every check it makes. A check that fails
 * answers with apply's own error instead.
 */
export type DeploymentCheckResponse = PlatformDeploymentCheck & {
  readonly webhookUrl: string | null;
};

export interface CredentialSharesResponse {
  readonly shares: readonly CredentialShare[];
}

export interface ConnectionAuthorizationRequest {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly provider?: string;
  readonly providerConfig?: Record<string, unknown>;
  readonly reuseFrom?: string;
  readonly scopes?: readonly string[];
}

/** GET /automations/:name returns the full active deployment. */
export type AutomationDeploymentResponse = PlatformDeploymentRecord;
export type DeleteAutomationResponse = DeleteAutomationResultRecord;
export interface AutomationDeletePreviewResponse {
  readonly dependents: readonly { readonly automationSlug: string; readonly environment: string }[];
  readonly hiddenDependents: number;
}
export type DeploymentAuditResponse = readonly AuditEventOf<"deployment">[];
export type TriggerAuditResponse = readonly AuditEventOf<"trigger">[];

export type {
  AuthUser as PersonResponse,
  AutomationFolder as AutomationFolderResponse,
  CreateProjectResult as CreateProjectResponse,
  CreateServiceAccountResult as CreateServiceAccountResponse,
  CreateTeamResult as CreateTeamResponse,
  CredentialAccessView as CredentialAccessResponse,
  CredentialShare as CredentialShareResponse,
  DashboardAutomationReadme as AutomationReadmeResponse,
  DashboardAutomationSource as AutomationSourceResponse,
  DashboardMermaidDiagram as AutomationMermaidResponse,
  DashboardOperationsSummary as OperationsSummaryResponse,
  DashboardRunDetail as DashboardRunResponse,
  DashboardStepReach as StepReachResponse,
  DeleteServiceAccountResult as DeleteServiceAccountResponse,
  DeleteTeamResult as DeleteTeamResponse,
  GrantRemovalResult as RemoveGrantResponse,
  GrantWriteResult as SetGrantResponse,
  IdentityResponse,
  MembershipResult as TeamMembershipResponse,
  MovedAutomation as MoveAutomationResponse,
  ProjectAccessView as ProjectAccessResponse,
  ProjectContentCounts as ProjectContentsResponse,
  ProtectionResult as EnvironmentProtectionResponse,
  RegisteredWorker as WorkerResponse,
  StoredEnvironment as EnvironmentResponse,
  StoredNotificationRule as NotificationRuleResponse,
  TokenView as TokenResponse,
  TwoFactorStatus as TwoFactorResponse,
  WorkerCredential as WorkerCredentialResponse,
  WorkerEnrollment as WorkerEnrollmentResponse,
} from "@swizzle/db";

export type RunStepsResponse = readonly DashboardRunStep[];
export type WorkerHeartbeatResponse = RegisteredWorker & PlacementWorker;
export interface WorkerSessionResponse {
  readonly worker: RegisteredWorker;
}
export interface WorkerAuditResponse {
  readonly events: readonly AuditEventOf<"worker">[];
}

export interface AuthStatusResponse {
  readonly authenticated: boolean;
  /** Whether the instance sends mail: without it nobody is invited or resets a password. */
  readonly mailConfigured: boolean;
  readonly setupRequired: boolean;
  readonly setupTokenRequired: boolean;
  readonly user: AuthUser | null;
}
export interface SessionsResponse {
  readonly sessions: readonly AuthSessionMetadata[];
}
export interface CreatedTokenResponse extends TokenView {
  readonly token: string;
}
export interface TokensResponse {
  readonly tokens: readonly TokenView[];
}

export interface InvitationResponse {
  readonly id: string;
  readonly email: string;
  readonly role: InstanceRole;
  readonly grants: readonly {
    readonly project: ProjectRef;
    readonly role: ProjectRole;
  }[];
  readonly invitedBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}
/**
 * POST /invitations: the new invitation with its link, `/invitation#<token>` on the dashboard. The
 * API shows the link in this answer only; `mailed` says whether it also went out by mail.
 */
export type SentInvitationResponse = InvitationResponse & {
  readonly url: string;
  readonly mailed: boolean;
};
export interface InvitationsResponse {
  readonly invitations: readonly InvitationResponse[];
}
export type InvitationOfferResponse = Pick<
  InvitationResponse,
  "email" | "expiresAt" | "invitedBy" | "role"
> & {
  readonly projects: InvitationResponse["grants"];
};

export interface AutomationFoldersResponse {
  readonly create: AccessRefusal | null;
  readonly folders: readonly (AutomationFolder & { readonly refusal: AccessRefusal | null })[];
}
export interface AssignAutomationFolderResponse {
  readonly status: "ok";
  readonly folderId: string | null;
}
export interface ApprovalAssigneeResponse {
  readonly assignee: ApprovalAssignee;
  readonly runId: string;
  readonly stepKey: string;
}
export interface AuditResponse {
  readonly events: readonly AuditEvent[];
  readonly next: string | null;
}
/** Each route's access rule and whether its requests enter the audit. HEAD follows GET. */
export type RouteAccess = "public" | "signed-in" | "session" | "instance" | "resource" | "worker";

const ROUTE_POLICY = {
  "POST /worker/enroll": { access: "public", audit: false },
  "GET /workers": { access: "instance", audit: false },
  "POST /workers/enrollments": { access: "instance", audit: true },
  "DELETE /workers/:workerId": { access: "instance", audit: true },
  "GET /workers/:workerId/audit": { access: "instance", audit: false },
  "POST /worker/heartbeat": { access: "worker", audit: false },
  "POST /worker/token/renew": { access: "worker", audit: false },
  "GET /worker/session": { access: "worker", audit: false },
  "POST /worker/preparations": { access: "worker", audit: false },
  "POST /worker/run-images": { access: "worker", audit: false },
  "POST /worker/run-images/keep": { access: "worker", audit: false },
  "POST /worker/image-checks": { access: "worker", audit: false },
  "POST /worker/runtime": { access: "worker", audit: false },
  "POST /worker/pull": { access: "worker", audit: false },
  "POST /worker/lease/renew": { access: "worker", audit: false },
  "POST /worker/source": { access: "worker", audit: false },
  "POST /worker/ready": { access: "worker", audit: false },
  "POST /worker/start": { access: "worker", audit: false },
  "POST /worker/output": { access: "worker", audit: false },
  "POST /worker/complete": { access: "worker", audit: false },
  "POST /worker/drain": { access: "worker", audit: false },

  "GET /health": { access: "public", audit: false },
  "GET /auth/status": { access: "public", audit: false },
  "POST /auth/sign-up/email": { access: "public", audit: false },
  "POST /auth/sign-in/email": { access: "public", audit: false },
  "POST /auth/sign-out": { access: "public", audit: false },
  "POST /auth/two-factor/verify-totp": { access: "public", audit: false },
  "POST /auth/two-factor/verify-backup-code": { access: "public", audit: false },
  "POST /auth/request-password-reset": { access: "public", audit: false },
  "POST /auth/reset-password": { access: "public", audit: false },
  "POST /auth/invitation": { access: "public", audit: false },
  "GET /oauth/callback/:provider": { access: "public", audit: false },
  "GET /approvals/:token": { access: "public", audit: false },
  "POST /approvals/:token": { access: "public", audit: true },
  "POST /events/:token": { access: "public", audit: true },
  // Webhook ingress under WEBHOOK_PATH_PREFIX: the automation's trigger decides, by signature
  // where it asks for one.
  "POST /hooks/*": { access: "public", audit: false },
  // Released 1.x sources may declare root paths; reserved namespaces are refused by ingress.
  "POST /*": { access: "public", audit: false },
  // CORS preflight.
  "OPTIONS *": { access: "public", audit: false },

  "POST /auth/change-password": { access: "session", audit: true },
  "POST /auth/two-factor/enable": { access: "session", audit: true },
  "POST /auth/two-factor/disable": { access: "session", audit: true },
  "GET /auth/two-factor": { access: "session", audit: false },
  "GET /auth/sessions": { access: "session", audit: false },
  "DELETE /auth/sessions/:sessionId": { access: "session", audit: true },
  "POST /auth/sessions/revoke-all": { access: "session", audit: true },
  "GET /auth/identity": { access: "signed-in", audit: false },
  "GET /auth/tokens": { access: "session", audit: false },
  "POST /auth/tokens": { access: "session", audit: true },
  "DELETE /auth/tokens/:identifier": { access: "session", audit: true },
  "GET /ready": { access: "signed-in", audit: false },
  "GET /environments": { access: "signed-in", audit: false },
  "GET /projects": { access: "signed-in", audit: false },
  "GET /teams": { access: "instance", audit: false },
  "GET /users": { access: "instance", audit: false },
  "GET /directory": { access: "resource", audit: false },
  // A person's own notification rules; an owner or admin sees and changes everyone's.
  "GET /notifications/rules": { access: "signed-in", audit: false },
  "POST /notifications/rules": { access: "signed-in", audit: true },
  "PATCH /notifications/rules/:ruleId": { access: "signed-in", audit: true },
  "DELETE /notifications/rules/:ruleId": { access: "signed-in", audit: true },
  // Owners and admins read all of it, a project admin their projects', anyone their own events.
  "GET /audit": { access: "signed-in", audit: false },

  "GET /metrics": { access: "instance", audit: false },
  "GET /ops/summary": { access: "instance", audit: false },
  "POST /security/audit": { access: "instance", audit: true },
  "POST /environments": { access: "instance", audit: true },
  "GET /notifications/deliveries": { access: "signed-in", audit: false },
  "GET /timeout-grants": { access: "instance", audit: false },
  "PUT /automations/:automationName/timeout-grant": { access: "instance", audit: true },
  "DELETE /automations/:automationName/timeout-grant": { access: "instance", audit: true },
  "POST /projects": { access: "instance", audit: true },
  "POST /teams": { access: "instance", audit: true },
  "DELETE /teams/:team": { access: "instance", audit: true },
  "PUT /teams/:team/members/:person": { access: "instance", audit: true },
  "DELETE /teams/:team/members/:person": { access: "instance", audit: true },
  "PUT /users/:userId/role": { access: "instance", audit: true },
  "PUT /users/:userId/suspension": { access: "instance", audit: true },
  "DELETE /users/:userId/suspension": { access: "instance", audit: true },
  "DELETE /users/:userId/two-factor": { access: "instance", audit: true },
  "POST /users/:userId/reset-link": { access: "instance", audit: true },
  "DELETE /users/:userId": { access: "instance", audit: true },
  "GET /invitations": { access: "instance", audit: false },
  "POST /invitations": { access: "instance", audit: true },
  "DELETE /invitations/:invitationId": { access: "instance", audit: true },

  "POST /deployments": { access: "resource", audit: true },
  "POST /deployment-checks": { access: "resource", audit: false },
  "GET /automations/:automationName": { access: "resource", audit: false },
  "DELETE /automations/:automationName": { access: "resource", audit: true },
  "GET /automations/:automationName/delete-preview": { access: "resource", audit: false },
  "GET /automations/:automationName/deployments": { access: "resource", audit: false },
  "GET /automations/:automationName/deployments/audit": { access: "resource", audit: false },
  "POST /automations/:automationName/rollback": { access: "resource", audit: true },
  "GET /automations/:automationName/secrets": { access: "resource", audit: false },
  "GET /automations/:automationName/state": { access: "resource", audit: false },
  "POST /automations/:automationName/state": { access: "resource", audit: true },
  "DELETE /automations/:automationName/state": { access: "resource", audit: true },
  "GET /automations/:automationName/trigger": { access: "resource", audit: false },
  "GET /automations/:automationName/trigger/audit": { access: "resource", audit: false },
  "POST /automations/:automationName/trigger/pause": { access: "resource", audit: true },
  "POST /automations/:automationName/trigger/resume": { access: "resource", audit: true },
  "POST /automations/:automationName/runs": { access: "resource", audit: true },
  "GET /automations/:automationName/timeout-grant": { access: "resource", audit: false },
  "PUT /automations/:automationName/folder": { access: "resource", audit: true },
  "PUT /automations/:automationName/project": { access: "resource", audit: true },
  "GET /automation-folders": { access: "resource", audit: false },
  "POST /automation-folders": { access: "resource", audit: true },
  "PATCH /automation-folders/:folderId": { access: "resource", audit: true },
  "DELETE /automation-folders/:folderId": { access: "resource", audit: true },
  "GET /secrets": { access: "resource", audit: false },
  "GET /secrets/:secretName": { access: "resource", audit: false },
  "PUT /secrets/:secretName": { access: "resource", audit: true },
  "DELETE /secrets/:secretName": { access: "resource", audit: true },
  "GET /connections": { access: "resource", audit: false },
  "GET /connections/:connectionName": { access: "resource", audit: false },
  "POST /connections/:connectionName/authorize": { access: "resource", audit: true },
  "POST /connections/:connectionName/test": { access: "resource", audit: true },
  "DELETE /connections/:connectionName": { access: "resource", audit: true },
  "GET /credentials/:kind/:name/access": { access: "resource", audit: false },
  "PUT /credentials/:kind/:name/grants": { access: "resource", audit: true },
  "DELETE /credentials/:kind/:name/grants": { access: "resource", audit: true },
  "PUT /credentials/:kind/:name/shares/:project": { access: "resource", audit: true },
  "DELETE /credentials/:kind/:name/shares/:project": { access: "resource", audit: true },
  "GET /projects/:project/credential-shares": { access: "resource", audit: false },
  "PUT /projects/:project/credential-shares/:shareId": { access: "resource", audit: true },
  "DELETE /projects/:project/credential-shares/:shareId": { access: "resource", audit: true },
  "GET /projects/:project/shared-credentials": { access: "resource", audit: false },
  "GET /projects/:project/worker-groups": { access: "resource", audit: false },
  "GET /dashboard/overview": { access: "resource", audit: false },
  "GET /dashboard/automations": { access: "resource", audit: false },
  "GET /dashboard/automations/:automationName": { access: "resource", audit: false },
  "GET /dashboard/automations/:automationName/readme": { access: "resource", audit: false },
  "GET /dashboard/automations/:automationName/mermaid": { access: "resource", audit: false },
  "GET /dashboard/automations/:automationName/source": { access: "resource", audit: false },
  "GET /dashboard/automations/:automationName/step-reach": { access: "resource", audit: false },
  "GET /dashboard/runs": { access: "resource", audit: false },
  "GET /dashboard/runs/:runId": { access: "resource", audit: false },
  "GET /dashboard/runs/:runId/steps": { access: "resource", audit: false },
  "GET /runs/:runId": { access: "resource", audit: false },
  "GET /runs/:runId/diagnosis": { access: "resource", audit: false },
  "POST /runs/:runId/replay": { access: "resource", audit: true },
  "POST /runs/:runId/cancel": { access: "resource", audit: true },
  "POST /runs/:runId/events/:stepKey": { access: "resource", audit: true },
  "POST /runs/:runId/approvals/:stepKey": { access: "resource", audit: true },
  "PUT /runs/:runId/approvals/:stepKey/assignee": { access: "resource", audit: true },
  "GET /runs/:runId/logs": { access: "resource", audit: false },
  "GET /runs/:runId/logs/stream": { access: "resource", audit: false },
  "DELETE /projects/:project": { access: "resource", audit: true },
  "GET /projects/:project/contents": { access: "resource", audit: false },
  "GET /projects/:project/access": { access: "resource", audit: false },
  "PUT /projects/:project/grants": { access: "resource", audit: true },
  "DELETE /projects/:project/grants": { access: "resource", audit: true },
  "PUT /projects/:project/environments/:environment/protection": {
    access: "resource",
    audit: true,
  },
  "DELETE /projects/:project/environments/:environment/protection": {
    access: "resource",
    audit: true,
  },
  "GET /projects/:project/service-accounts": { access: "resource", audit: false },
  "POST /projects/:project/service-accounts": { access: "resource", audit: true },
  "DELETE /projects/:project/service-accounts/:account": { access: "resource", audit: true },
  "POST /projects/:project/service-accounts/:account/tokens": { access: "resource", audit: true },
  "POST /projects/:project/service-accounts/:account/tokens/:identifier/rotation": {
    access: "resource",
    audit: true,
  },
  "DELETE /projects/:project/service-accounts/:account/tokens/:identifier": {
    access: "resource",
    audit: true,
  },
} as const satisfies Readonly<
  Record<string, { readonly access: RouteAccess; readonly audit: boolean }>
>;

/** Every route by METHOD and path, used by route registration and access checks. */
export const ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = Object.fromEntries(
  Object.entries(ROUTE_POLICY).map(([route, policy]) => [route, policy.access]),
);

export type AuditedRoute = {
  [Route in keyof typeof ROUTE_POLICY]: (typeof ROUTE_POLICY)[Route]["audit"] extends true
    ? Route
    : never;
}[keyof typeof ROUTE_POLICY];

/** The same membership the dashboard must word, used by the request audit hook. */
export const AUDITED_ROUTES: ReadonlySet<string> = new Set(
  Object.entries(ROUTE_POLICY)
    .filter(([, policy]) => policy.audit)
    .map(([route]) => route),
);

export interface SharedCredentialsResponse {
  readonly credentials: readonly SharedCredential[];
}
export type DeleteTimeoutGrantResponse = Omit<TimeoutGrantResponse, "grant"> & {
  readonly deleted: true;
};
export interface EventCallbackResponse {
  readonly resumed: true;
}

export interface SecurityAuditResponse {
  readonly checkedAt: string;
  readonly checks: readonly {
    readonly detail: string;
    readonly id: string;
    readonly level: "critical" | "pass" | "warning";
    readonly title: string;
  }[];
  readonly status: "attention" | "ok";
  readonly summary: {
    readonly critical: number;
    readonly passed: number;
    readonly warnings: number;
  };
}

/** The body of every control-plane error answer, with the status of its code. */
export type { ApiErrorResponse } from "@swizzle/core";

/** 204 responses have no wire body; handlers either send nothing or return null. */
export type NoContentResponse = null | undefined;
export type HtmlResponse = string;
export type MetricsResponse = string;
/** A completed sign-up, sign-out, password or factor verification/disable action. */
export type AuthActionResponse = AuthActionResult;
/** POST /auth/sign-in/email, as the auth boundary in @swizzle/db/postgres parses it. */
export type SignInResponse = SignInResult;
/** POST /auth/two-factor/enable, as the auth boundary in @swizzle/db/postgres parses it. */
export type TwoFactorEnrollmentResponse = TwoFactorEnrollment;
/** Server-sent event bytes consumed by the CLI and browser's stream readers. */
export type RunLogStreamResponse = AsyncIterable<string | Uint8Array>;

/** A schema-defined worker reply, without pulling its validators into browser type checking. */
export type WorkerDispatchResponse<
  Route extends { readonly reply: { parse(value: unknown): unknown } },
> = ReturnType<Route["reply"]["parse"]>;

export type { DeploymentChange } from "./platform-records.js";

// A root webhook must never turn an API namespace into an anonymous trigger lookup.
const RESERVED_WEBHOOK_NAMESPACES = new Set([
  "api",
  ...Object.keys(ROUTE_POLICY)
    .map((route) => route.split(" ")[1]?.split("/")[1])
    .filter((part) => part !== undefined && part !== "*" && part !== "hooks"),
]);

export function isWebhookDeliveryPath(path: string): boolean {
  return !RESERVED_WEBHOOK_NAMESPACES.has(path.split("/")[1] ?? "");
}
