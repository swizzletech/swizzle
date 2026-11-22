import type * as Http from "@swizzle/runtime/http-contract";
import { INVALID_BODY, type ResponseDecoder } from "./api.js";

type Check = (value: unknown) => boolean;
type Rule = Check | { readonly [key: string]: Rule | undefined } | [Rule] | [null, Rule];

type Shape<T> = { readonly [Key in keyof T]?: Field<T[Key]> };
type Structure<T> = T extends readonly (infer Item)[]
  ? [Field<Item>]
  : T extends object
    ? Shape<T>
    : never;
type Field<T> =
  | Check
  | Structure<NonNullable<T>>
  | (null extends T ? [null, Check | Structure<NonNullable<T>>] : never);

type HealthProbe = Pick<Http.HealthResponse, "service"> & {
  readonly version?: Http.HealthResponse["version"] | null;
};

function matches(value: unknown, rule: Rule): boolean {
  if (typeof rule === "function") return rule(value);
  if (Array.isArray(rule)) {
    if (rule.length === 2) return value === null || matches(value, rule[1]);
    return Array.isArray(value) && value.every((item) => matches(item, rule[0]));
  }
  return (
    record(value) &&
    Object.entries(rule).every(([key, field]) => field !== undefined && matches(value[key], field))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const string: Check = (value) => typeof value === "string";
const number: Check = (value) => typeof value === "number";
const boolean: Check = (value) => typeof value === "boolean";
const maybeString: Check = (value) => value === undefined || value === null || string(value);
const present: Check = (value) => value !== undefined;
const strings: [Check] = [string];

function response<T>(shape: Shape<T>): ResponseDecoder<T> {
  return { decode: (body) => (matches(body, shape) ? (body as T) : INVALID_BODY) };
}

const project = { slug: string } satisfies Shape<Http.ConnectionResponse["project"]>;
const connectionIdentity = {
  name: string,
  project,
  provider: string,
  status: string,
  authorizationPending: boolean,
  lastErrorCode: [null, string],
} satisfies Shape<Http.ConnectionResponse>;
const connection = {
  ...connectionIdentity,
  environment: string,
  clientId: string,
  scopes: strings,
  tokenVersion: number,
  accessTokenExpiresAt: [null, string],
  lastRefreshedAt: [null, string],
  lastErrorAt: [null, string],
  updatedAt: string,
} satisfies Shape<Http.ConnectionResponse>;
const credentialShare = {
  shareId: string,
  credential: { kind: string, name: string, environment: string },
  acceptedAt: [null, string],
} satisfies Shape<Http.CredentialShareResponse>;
const worker = { id: string, name: string } satisfies Shape<Http.WorkerResponse>;
const workerStatus = {
  name: string,
  state: string,
  draining: boolean,
  services: strings,
  lastSeenAt: [null, string],
  localLlm: [null, string],
} satisfies Shape<Http.WorkerGroupsResponse["groups"][number]["workers"][number]>;
const workerListing = {
  ...workerStatus,
  id: string,
  profiles: strings,
  kind: string,
  slotsInUse: number,
  capacity: number,
  tokenExpiresAt: [null, string],
  currentRuns: [{ automationSlug: string, runId: string }],
  runImageDiskWarning: [null, { title: string, todo: string }],
} satisfies Shape<Http.WorkersResponse["workers"][number]>;
const readiness = {
  status: string,
  errors: [{ message: string }],
  warnings: [{ message: string }],
} satisfies Shape<Http.ApplyResponse["readiness"]>;
const deploymentChange = {
  field: string,
} satisfies Shape<Http.DeploymentChange>;
const deployment = {
  deploymentId: string,
  version: string,
  seq: number,
  deployedAt: string,
} satisfies Shape<Http.DeploymentResponse>;
const secretMetadata = {
  name: string,
  project,
  secretVersion: number,
  updatedAt: string,
} satisfies Shape<Http.SecretResponse>;
const notificationRule = {
  ruleId: string,
  automationSlug: maybeString,
  eventType: string,
  enabled: boolean,
  chatId: string,
} satisfies Shape<Http.NotificationRuleResponse>;
const stateValue = { value: present, updatedAt: string } satisfies Shape<
  NonNullable<Http.StateValueResponse["state"]>
>;
const timeoutGrant = {
  maxTimeoutMs: number,
  automationSlug: string,
  note: [null, string],
} satisfies Shape<NonNullable<Http.TimeoutGrantResponse["grant"]>>;

export const deleteAutomationResponse: ResponseDecoder<Http.DeleteAutomationResponse> =
  response<Http.DeleteAutomationResponse>({
    automationSlug: string,
    environment: string,
    deletedCounts: { deployments: number, runs: number },
    kept: { auditEvents: number },
    artifactsRemoved: boolean,
    artifactError: maybeString,
  });

export const responses = {
  apply: response<Http.ApplyResponse>({
    ...deployment,
    action: string,
    automationName: string,
    changes: [deploymentChange],
    readiness: { status: string },
    warnings: strings,
    webhookUrl: [null, string],
  }),
  automationDeletePreview: response<Http.AutomationDeletePreviewResponse>({
    dependents: [{ automationSlug: string, environment: string }],
    hiddenDependents: number,
  }),
  automationDetail: response<Http.AutomationDetailResponse>({
    automationSlug: string,
    automationName: string,
    environment: string,
    activeDeployment: {
      ...deployment,
      runtimeSnapshot: { language: string, execution_mode: string, profile: string },
      readiness,
      vars: record,
    },
    requiredSecrets: [{ name: string, state: string }],
    recentRuns: [{ state: string, runId: string, queuedAt: string, errorCode: maybeString }],
    deploymentHistory: Array.isArray,
  }),
  automations: response<Http.AutomationsResponse>({
    automations: [
      {
        automationSlug: string,
        automationName: string,
        activeDeployment: {
          deployedAt: string,
          triggerType: string,
          version: string,
          readiness: { status: string, errors: readiness.errors },
        },
        requiredSecrets: [{ name: string }],
        trigger: [null, { status: string }],
        lastRun: [null, { state: string, queuedAt: string }],
      },
    ],
  }),
  authorizeConnection: response<Http.AuthorizeConnectionResponse>({
    authorizationUrl: string,
    connection: { ...connectionIdentity, environment: string },
    expiresAt: string,
    redirectUri: string,
  }),
  cancelRun: response<Http.CancelRunResponse>({
    alreadyTerminal: boolean,
    run: { runId: string, status: string, state: string, deadLetterReason: [null, string] },
  }),
  connection: response<Http.ConnectionResponse>(connection),
  connections: response<Http.ConnectionsResponse>({
    environment: string,
    connections: [connectionIdentity],
  }),
  createProject: response<Http.CreateProjectResponse>({
    slug: string,
    name: string,
    changed: boolean,
  }),
  createServiceAccount: response<Http.CreateServiceAccountResponse>({
    name: string,
    changed: boolean,
  }),
  createTeam: response<Http.CreateTeamResponse>({ name: string, changed: boolean }),
  credentialAccess: response<Http.CredentialAccessResponse>({
    credential: credentialShare.credential,
    right: string,
    holders: [
      {
        name: string,
        email: [null, string],
        subject: { kind: string },
        right: string,
        sources: [{ kind: string }],
      },
    ],
    shares: [{ project: { name: string }, acceptedAt: [null, string] }],
    serviceAccounts: [{ id: string, name: string }],
  }),
  credentialShare: response<Http.CredentialShareResponse>(credentialShare),
  credentialShares: response<Http.CredentialSharesResponse>({
    shares: [{ ...credentialShare, credentialProject: { name: string } }],
  }),
  deleteProject: response<Http.DeleteProjectResponse>({ project: string, changed: boolean }),
  deleteServiceAccount: response<Http.DeleteServiceAccountResponse>({
    serviceAccount: string,
    changed: boolean,
  }),
  deleteState: response<Http.DeleteStateResponse>({ deleted: boolean }),
  deleteTeam: response<Http.DeleteTeamResponse>({ team: string, changed: boolean }),
  deleteTimeoutGrant: response<Http.DeleteTimeoutGrantResponse>({ deleted: boolean }),
  deployment: response<Http.DeploymentResponse>(deployment),
  deploymentCheck: response<Http.DeploymentCheckResponse>({
    action: string,
    changes: [deploymentChange],
    readiness,
    webhookUrl: [null, string],
  }),
  deployments: response<Http.DeploymentsResponse>({
    environment: string,
    deployments: [deployment],
  }),
  environmentProtection: response<Http.EnvironmentProtectionResponse>({
    project: string,
    environment: string,
    changed: boolean,
    grantsRemoved: number,
  }),
  environments: response<Pick<Http.EnvironmentsResponse, "environments">>({
    environments: [{ name: string, hasData: boolean, liveServices: strings }],
  }),
  health: response<HealthProbe>({
    service: (value) => value === "api",
    version: maybeString,
  }),
  identity: response<Http.IdentityResponse>({
    kind: (value) => value === "person" || value === "service-account",
    person: [null, { name: string, email: string, role: string }],
    serviceAccount: [null, { name: string, project }],
    token: [
      null,
      {
        name: string,
        expiresAt: string,
        scope: { role: string, projects: [null, [project]], environments: [null, strings] },
      },
    ],
    target: [null, { project: { reference: string }, role: [null, string] }],
  }),
  moveAutomation: response<Http.MoveAutomationResponse>({ automationSlug: string, moved: boolean }),
  notificationDeliveries: response<Http.NotificationDeliveriesResponse>({
    environment: string,
    deliveries: [
      {
        createdAt: string,
        automationSlug: string,
        eventType: string,
        status: string,
        errorMessage: [null, string],
      },
    ],
  }),
  notificationRule: response<Http.NotificationRuleResponse>({
    ...notificationRule,
    threshold: number,
    windowSeconds: number,
    cooldownSeconds: number,
  }),
  notificationRules: response<Http.NotificationRulesResponse>({
    environment: string,
    rules: [notificationRule],
  }),
  operationsSummary: response<Http.OperationsSummaryResponse>({
    environment: string,
    state: string,
    stateReasons: strings,
    maintenance: { state: string },
    notifications: { sent: number, failed: number },
    queue: { counts: { waiting: number, failed: number } },
  }),
  overview: response<Http.OverviewResponse>({
    needsYou: [{ kind: string }],
    last24h: record,
  }),
  people: response<Http.PeopleResponse>({
    users: [
      {
        id: string,
        email: string,
        name: string,
        role: string,
        suspended: boolean,
        twoFactorEnabled: boolean,
      },
    ],
  }),
  projectAccess: response<Http.ProjectAccessResponse>({
    project,
    protectedEnvironments: strings,
    holders: [
      {
        name: string,
        email: [null, string],
        subject: { kind: string },
        role: [null, string],
        environments: record,
      },
    ],
    grants: [{ subject: { kind: string }, role: string, on: string }],
    automationSlugs: record,
  }),
  projects: response<Http.ProjectsResponse>({
    projects: [{ slug: string, name: string, role: string, protectedEnvironments: strings }],
  }),
  ready: response<Pick<Http.ReadyResponse, "checks">>({ checks: record }),
  removeGrant: response<Http.RemoveGrantResponse>({
    project: string,
    subject: string,
    changed: boolean,
  }),
  resetLink: response<Http.ResetLinkResponse>({ url: string, expiresAt: string }),
  resumeRun: response<Http.ResumeRunResponse>({
    resumed: (value) => value === true,
    runId: string,
    stepKey: string,
  }),
  run: response<Http.RunResponse>({
    runId: string,
    automationSlug: maybeString,
    automationName: maybeString,
    state: string,
    status: string,
    attemptsMade: number,
    attemptsMax: number,
    stdout: maybeString,
    stderr: maybeString,
    placement: [null, record],
    executions: [{ stdout: maybeString, stderr: maybeString }],
  }),
  runDiagnosis: response<Http.RunDiagnosisResponse>({
    runId: string,
    automation: [null, string],
    state: string,
    status: string,
    attempts: { made: number, max: number },
    likelyCause: { code: string, summary: string },
    evidence: [{ kind: string, detail: string }],
    suggestedFixes: [{ confidence: number, command: maybeString, rationale: string }],
  }),
  runLogs: response<Http.RunLogsResponse>({
    chunks: [{ chunk: string, stream: string }],
    cursor: string,
    terminal: boolean,
  }),
  runs: response<Http.RunsResponse>({
    runs: [
      { runId: string, status: string, state: string, automationSlug: string, queuedAt: string },
    ],
  }),
  secret: response<Http.SecretResponse>({
    ...secretMetadata,
    environment: string,
    algorithm: string,
    keyVersion: string,
    createdAt: string,
  }),
  secrets: response<Http.SecretsResponse>({ environment: string, secrets: [secretMetadata] }),
  securityAudit: response<Http.SecurityAuditResponse>({
    status: string,
    checkedAt: string,
    checks: [{ level: string, id: string, title: string, detail: string }],
    summary: { critical: number, passed: number, warnings: number },
  }),
  sentInvitation: response<Http.SentInvitationResponse>({
    email: string,
    role: string,
    grants: [{ project, role: string }],
    url: string,
    expiresAt: string,
    mailed: boolean,
  }),
  serviceAccounts: response<Http.ServiceAccountsResponse>({
    serviceAccounts: [
      {
        name: string,
        grants: [{ on: string, role: string }],
        tokens: [{ revokedAt: [null, string], expiresAt: string }],
        createdBy: { name: string },
      },
    ],
  }),
  setGrant: response<Http.SetGrantResponse>({
    project: string,
    subject: string,
    role: string,
    previousRole: [null, string],
  }),
  setSecret: response<Http.SetSecretResponse>({
    name: string,
    environment: string,
    secretVersion: number,
    warnings: (value) => value == null || (Array.isArray(value) && value.every(string)),
  }),
  setState: response<Http.SetStateResponse>({ state: stateValue }),
  setTimeoutGrant: response<Http.SetTimeoutGrantResponse>({
    grant: { ...timeoutGrant, environment: string },
  }),
  stateList: response<Http.StateListResponse>({ state: [{ ...stateValue, key: string }] }),
  stateValue: response<Http.StateValueResponse>({ state: [null, stateValue] }),
  teamMembership: response<Http.TeamMembershipResponse>({
    team: string,
    person: string,
    changed: boolean,
  }),
  teams: response<Http.TeamsResponse>({
    teams: [{ id: string, name: string, memberIds: strings }],
  }),
  testConnection: response<Http.TestConnectionResponse>({
    connection: connectionIdentity,
    refreshed: boolean,
    accessTokenExpiresAt: [null, string],
  }),
  timeoutGrant: response<Http.TimeoutGrantResponse>({
    environment: string,
    grant: [null, { ...timeoutGrant, createdAt: string }],
  }),
  timeoutGrants: response<Http.TimeoutGrantsResponse>({
    environment: string,
    grants: [timeoutGrant],
  }),
  triggerRun: response<Http.TriggerRunResponse>({
    runId: string,
    deploymentId: string,
    status: string,
    state: string,
    queuedAt: string,
    warning: maybeString,
  }),
  triggerStatus: response<Http.TriggerStatusResponse>({ triggerId: string, status: string }),
  worker: response<Http.WorkerResponse>({ id: string, name: string }),
  workerCredential: response<Http.WorkerCredentialResponse>({
    worker: { id: string, name: string, tokenExpiresAt: string },
    token: string,
  }),
  workerEnrollment: response<Http.WorkerEnrollmentResponse>({
    worker,
    code: string,
    expiresAt: string,
  }),
  workerGroups: response<Http.WorkerGroupsResponse>({
    groups: [{ name: string, workers: [workerStatus] }],
  }),
  workers: response<Http.WorkersResponse>({ workers: [workerListing] }),
};
