/**
 * Who may do what to which automation, in which environment (ADR 0014). Every API route asks
 * `decide` or `readScope`; nothing else in Swizzle decides access.
 *
 * - An instance owner or admin may do everything.
 * - Anyone else holds roles per project and per automation, directly or through a team. The
 *   highest role that applies counts; there are no deny rules.
 * - A protected environment caps that role: there a person has at most the highest role an
 *   environment grant gives them, and nothing without one. A project admin keeps admin.
 *
 * - A credential (a secret or a connection) has rights of its own: `use` lets a person bind it in
 *   a deployment, `manage` also lets them set, rotate, delete, grant and share it. No right shows a
 *   stored value. See `credentialRight`.
 *
 * - A request that comes with a token is limited by that token's scope as well: at most its
 *   role, only in its projects and environments. The scope is fixed when the token is minted, so
 *   rights its person or service account gains later never widen a narrowed token.
 * - A service account is a project's own identity. It holds grants like a person but never an
 *   instance role and never admin; its tokens keep working whoever minted them.
 *
 * The grants are read fresh for every request (access-store.ts), so a revoked grant takes effect
 * on the next one.
 */
import type { ApprovalAssignee } from "./run-approval.js";

export const PROJECT_ROLES = ["viewer", "operator", "editor", "admin"] as const;
/** A role in a project, lowest first. */
export type ProjectRole = (typeof PROJECT_ROLES)[number];
/** The roles an automation share or an environment grant gives; administering stays per project. */
export type ShareRole = Exclude<ProjectRole, "admin">;

export const INSTANCE_ROLES = ["owner", "admin", "member"] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

/** The project a fresh instance starts with; a new automation lands here unless told otherwise. */
export const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
/** The environment a new project protects. */
export const PROTECTED_BY_DEFAULT = "production";
/**
 * The team a fresh instance starts with. Its first owner joins it at setup, and every project
 * grants it PROTECTED_BY_DEFAULT as RELEASE_ROLE until an admin removes that grant. An admin may
 * delete the team; new projects then start without the grant.
 */
export const RELEASE_TEAM_ID = "00000000-0000-4000-8000-000000000002";
export const RELEASE_ROLE: ShareRole = "editor";

export type Subject =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "team"; readonly teamId: string }
  | { readonly kind: "service-account"; readonly serviceAccountId: string };

/**
 * The most a token may do. `projectIds` and `environments` null mean every one the actor reaches.
 * A token whose scope is FULL_SCOPE acts with all of its person's rights, instance role included.
 * A token with `environments` never administers a whole project.
 */
export interface TokenScope {
  readonly role: ProjectRole;
  readonly projectIds: readonly string[] | null;
  readonly environments: readonly string[] | null;
}

export const FULL_SCOPE: TokenScope = { environments: null, projectIds: null, role: "admin" };

/** The highest role a service account may hold or a service account token may carry. */
export const SERVICE_ACCOUNT_MAX_ROLE: ShareRole = "editor";

/** The team a grant came through, or null for a grant to the person. */
export type GrantVia = { readonly teamId: string; readonly teamName: string } | null;

export type Grant =
  | {
      readonly on: "project";
      readonly projectId: string;
      readonly role: ProjectRole;
      readonly via: GrantVia;
    }
  | {
      readonly on: "automation";
      readonly automationId: string;
      readonly projectId: string;
      readonly role: ShareRole;
      readonly via: GrantVia;
    }
  | {
      readonly on: "environment";
      readonly projectId: string;
      readonly environment: string;
      readonly role: ShareRole;
      readonly via: GrantVia;
    };

/** Everything the policy knows about one actor. */
export interface AccessGrants {
  readonly instanceRole: InstanceRole;
  /** The person and each of their teams: whom a credential grant must name to reach them. */
  readonly subjects: readonly Subject[];
  readonly grants: readonly Grant[];
  /** The protected environments of every project a grant names. */
  readonly protectedEnvironments: readonly {
    readonly projectId: string;
    readonly environment: string;
  }[];
  /** The scope of the token the request came with; null for a browser session. */
  readonly scope: TokenScope | null;
}

/** An automation, or with `automationId: null` a project as such (a first deploy, sharing). */
export interface AccessTarget {
  readonly automationId: string | null;
  readonly projectId: string;
}

/**
 * What a request wants to do. Reading, running and editing happen in one environment; deleting
 * an automation removes it from every environment; organizing (folders) touches none.
 */
export type Need =
  | { readonly action: "read" | "run" | "edit"; readonly environment: string }
  | { readonly action: "delete" }
  | { readonly action: "organize" }
  | { readonly action: "administer" };

export type Decision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /**
       * False when no project or automation grant names the target: answer as if it did not
       * exist. A person capped out of a protected environment still knows the automation.
       */
      readonly visible: boolean;
      readonly role: ProjectRole | null;
      readonly required: ProjectRole;
      readonly sources: readonly Grant[];
      /** The token's scope when it alone refuses: a project admin with this token would fall short. */
      readonly scope: TokenScope | null;
      /**
       * The environment asked about when its protection alone refuses: the actor's role there
       * without the cap would do. A refusal then says only a grant of it helps. Both this and
       * `scope` are set when each refuses on its own.
       */
      readonly protectedEnvironment: string | null;
    };

/**
 * Why the policy refuses an actor something they can see: what it needs, the role they hold and
 * from which grants, and what limits it. A 403's details carry it, and the dashboard says it next
 * to a control it does not offer.
 */
export type AccessRefusal = Omit<Extract<Decision, { allowed: false }>, "allowed" | "visible">;

export function refusalOf(decision: Extract<Decision, { allowed: false }>): AccessRefusal {
  const { protectedEnvironment, required, role, scope, sources } = decision;
  return { protectedEnvironment, required, role, scope, sources };
}

/**
 * What a list may show in one environment: whole projects, and automations shared one by one.
 * A share reaches only what its automation owns in the project it is in now, so runs and audit
 * events written before a move stay with the project they were written in.
 */
export type ReadScope =
  | { readonly all: true }
  | {
      readonly all: false;
      readonly projectIds: readonly string[];
      readonly automations: readonly {
        readonly automationId: string;
        readonly projectId: string;
      }[];
    };

export const CREDENTIAL_KINDS = ["secret", "connection"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const CREDENTIAL_RIGHTS = ["use", "manage"] as const;
/** `use` binds a credential in a deployment; `manage` also sets, rotates, deletes, grants and shares it. */
export type CredentialRight = (typeof CREDENTIAL_RIGHTS)[number];

/** A credential by the project and environment that own it. */
export interface CredentialTarget {
  readonly kind: CredentialKind;
  readonly id: string;
  readonly projectId: string;
  readonly environment: string;
}

/** A person's or a team's right on one credential. */
export interface CredentialGrant {
  readonly subject: Subject;
  readonly right: CredentialRight;
}

const RANK: Readonly<Record<ProjectRole, number>> = { admin: 3, editor: 2, operator: 1, viewer: 0 };

const REQUIRED: Readonly<Record<Need["action"], ProjectRole>> = {
  administer: "admin",
  delete: "editor",
  edit: "editor",
  organize: "editor",
  read: "viewer",
  run: "operator",
};

const OPERATOR_ROLES: ReadonlySet<InstanceRole> = new Set(["owner", "admin"]);

/**
 * Owners and admins see every project; that access is theirs by instance role, not by grant. Only
 * a session or a full-scope token carries it; a narrowed token of an owner acts as admin of every
 * project inside its scope and nothing more.
 */
export function isInstanceOperator(access: AccessGrants): boolean {
  return operatesInstance(access) && unlimited(access.scope);
}

/** The projects the actor holds a project role in, or "all". */
export function reachedProjects(access: AccessGrants): readonly string[] | "all" {
  if (operatesInstance(access)) return access.scope?.projectIds ?? "all";
  const projectIds = access.grants.flatMap((grant) =>
    grant.on === "project" && withinScope(access.scope, grant.projectId, null)
      ? [grant.projectId]
      : [],
  );
  return [...new Set(projectIds)];
}

/** What of the audit an actor reads (apps/api/src/request-audit.ts). */
export interface AuditView {
  /** Only events of these projects; null for every project. */
  readonly projectIds: readonly string[] | null;
  /** Only events in these environments; null for any. */
  readonly environments: readonly string[] | null;
  /** Only the actor's own events. */
  readonly ownOnly: boolean;
}

/**
 * What of the audit the actor reads. An owner or admin with an unlimited token reads every event,
 * and an admin of a project that project's, with a token that reaches each of its environments.
 * Anyone else reads their own events, within their token's projects and environments.
 */
export function auditView(access: AccessGrants): AuditView {
  if (isInstanceOperator(access)) return { environments: null, ownOnly: false, projectIds: null };
  const environments = access.scope?.environments ?? null;
  const reached = environments === null ? reachedProjects(access) : [];
  const administered =
    reached === "all"
      ? []
      : reached.filter((projectId) => projectRole(access, projectId) === "admin");
  if (administered.length > 0) {
    return { environments: null, ownOnly: false, projectIds: administered };
  }
  return { environments, ownOnly: true, projectIds: access.scope?.projectIds ?? null };
}

/**
 * Whether an instance role may invite, change, suspend or remove a person whose roles before and
 * after are `roles`. Owners manage everyone; admins manage everyone but owners and make none.
 */
export function mayManagePeople(actor: InstanceRole, ...roles: readonly InstanceRole[]): boolean {
  if (actor === "owner") return true;
  return actor === "admin" && !roles.includes("owner");
}

export function decide(access: AccessGrants, need: Need, target: AccessTarget): Decision {
  if (isInstanceOperator(access)) return { allowed: true };
  const required = REQUIRED[need.action];
  const short = (role: ProjectRole | null) => role === null || !atLeast(role, required);
  const role = roleFor(access, need, target);
  if (!short(role)) return { allowed: true };
  const environment = "environment" in need ? need.environment : null;
  // A project admin holding the same token: what the scope alone allows here.
  const tokenCeiling = roleFor(
    {
      ...access,
      grants: [{ on: "project", projectId: target.projectId, role: "admin", via: null }],
      instanceRole: "member",
    },
    need,
    target,
  );
  return {
    allowed: false,
    protectedEnvironment:
      environment !== null &&
      isProtected(access, target.projectId, environment) &&
      !short(unscopedObjectRole(access, target)) &&
      short(unscopedRoleIn(access, target, environment))
        ? environment
        : null,
    required,
    role,
    scope: access.scope !== null && short(tokenCeiling) ? access.scope : null,
    sources: sourcesFor(access, target, environment),
    visible: objectRole(access, target) !== null,
  };
}

export function readScope(access: AccessGrants, environment: string): ReadScope {
  if (isInstanceOperator(access)) return { all: true };
  if (operatesInstance(access)) {
    const { scope } = access;
    if (!withinScope(scope, null, environment))
      return { all: false, automations: [], projectIds: [] };
    return scope === null || scope.projectIds === null
      ? { all: true }
      : { all: false, automations: [], projectIds: scope.projectIds };
  }
  const projectIds = new Set<string>();
  const automations = new Map<string, { automationId: string; projectId: string }>();
  for (const grant of access.grants) {
    if (grant.on === "environment") continue;
    const target = {
      automationId: grant.on === "automation" ? grant.automationId : null,
      projectId: grant.projectId,
    };
    if (roleIn(access, target, environment) === null) continue;
    if (grant.on === "project") projectIds.add(grant.projectId);
    else {
      automations.set(grant.automationId, {
        automationId: grant.automationId,
        projectId: grant.projectId,
      });
    }
  }
  return { all: false, automations: [...automations.values()], projectIds: [...projectIds] };
}

export function projectRole(access: AccessGrants, projectId: string): ProjectRole | null {
  const role = operatesInstance(access)
    ? "admin"
    : highest(
        access.grants.flatMap((grant) =>
          grant.on === "project" && grant.projectId === projectId ? [grant.role] : [],
        ),
      );
  return capped(access.scope, role, projectId, null);
}

/** The actor's role in a project as such in one environment, after the environment caps it. */
export function environmentRole(
  access: AccessGrants,
  projectId: string,
  environment: string,
): ProjectRole | null {
  return roleIn(access, { automationId: null, projectId }, environment);
}

/**
 * The most a protected environment lets the actor do there: the highest of their grants of it,
 * which caps their project role. Null when it is not protected or no such grant reaches them.
 */
export function environmentCap(
  access: AccessGrants,
  projectId: string,
  environment: string,
): ProjectRole | null {
  if (!isProtected(access, projectId, environment)) return null;
  return highest(
    access.grants.flatMap((grant) =>
      grant.on === "environment" &&
      grant.projectId === projectId &&
      grant.environment === environment
        ? [grant.role]
        : [],
    ),
  );
}

export function inScope(
  scope: ReadScope,
  target: { readonly automationId: string; readonly projectId: string },
): boolean {
  return (
    scope.all ||
    scope.projectIds.includes(target.projectId) ||
    scope.automations.some(
      (shared) =>
        shared.automationId === target.automationId && shared.projectId === target.projectId,
    )
  );
}

/**
 * Why an actor holds its right on a credential: the role that gives it without a grant, and every
 * grant that names the actor or one of their teams. A credential's access list shows both, so
 * removing one grant never reads as a full revocation.
 */
export interface CredentialRightBasis {
  readonly right: CredentialRight | null;
  /** Instance owner or admin, or admin of the owning project; null when only grants count. */
  readonly role: "owner" | "admin" | "project-admin" | null;
  readonly grants: readonly CredentialGrant[];
}

/**
 * The actor's right on a credential, given every grant on it. An instance owner or admin and an
 * admin of the owning project manage it. A manage grant manages only while its holder may edit the
 * credential's environment; otherwise it uses, like a use grant. A use grant needs no role in the
 * owning project, so a person of another project can hold one. A token's scope caps the role in
 * each of these, and a credential outside the token's projects or environments holds no right.
 */
export function credentialRight(
  access: AccessGrants,
  credential: CredentialTarget,
  grants: readonly CredentialGrant[],
): CredentialRight | null {
  return credentialRightBasis(access, credential, grants).right;
}

/** `credentialRight` with the role and the grants it came from. */
export function credentialRightBasis(
  access: AccessGrants,
  credential: CredentialTarget,
  grants: readonly CredentialGrant[],
): CredentialRightBasis {
  const held = grants.filter((grant) =>
    access.subjects.some((subject) => sameSubject(subject, grant.subject)),
  );
  if (!withinScope(access.scope, credential.projectId, credential.environment)) {
    return { grants: held, right: null, role: null };
  }
  const owner = { automationId: null, projectId: credential.projectId };
  const role = roleIn(access, owner, credential.environment);
  const byRole = roleHolding(access, owner, credential.environment);
  if (role !== null && byRole !== null) {
    return { grants: held, right: atLeast(role, "editor") ? "manage" : "use", role: byRole };
  }
  if (held.length === 0) return { grants: held, right: null, role: null };
  const manages = held.some((grant) => grant.right === "manage");
  return {
    grants: held,
    right: manages && role !== null && atLeast(role, "editor") ? "manage" : "use",
    role: null,
  };
}

/** The role that manages every credential of `owner`'s project, before a token's scope caps it. */
function roleHolding(
  access: AccessGrants,
  owner: AccessTarget,
  environment: string,
): CredentialRightBasis["role"] {
  if (access.instanceRole !== "member") return access.instanceRole;
  if (unscopedRoleIn(access, owner, environment) === "admin") return "project-admin";
  return null;
}

/**
 * Whether the actor may bind the credential in a deployment to `projectId`: with a right on it, or,
 * for one shared into that project, as its admin, who accepted the share for it.
 */
export function mayUseCredential(
  access: AccessGrants,
  credential: CredentialTarget,
  grants: readonly CredentialGrant[],
  projectId: string,
): boolean {
  if (credentialRight(access, credential, grants) !== null) return true;
  return (
    credential.projectId !== projectId &&
    roleIn(access, { automationId: null, projectId }, credential.environment) === "admin"
  );
}

/**
 * What the actor may do with an open approval of a run they can read (ADR 0014). An approval
 * assigned to a person or a team is decided by that person or a current member of that team,
 * whatever their role; one assigned to nobody by anyone who may run the run. Owners, admins and
 * admins of the run's project reassign it, and decide it only once it is theirs, so a decision
 * always names the person it was assigned to or one of their team.
 */
export function approvalRights(
  access: AccessGrants,
  assignee: ApprovalAssignee | null,
  run: AccessTarget & { readonly environment: string },
): { readonly decide: boolean; readonly reassign: boolean } {
  const reassign = decide(access, { action: "administer" }, run).allowed;
  if (assignee === null) {
    return {
      decide: decide(access, { action: "run", environment: run.environment }, run).allowed,
      reassign,
    };
  }
  const assigned = access.subjects.some((subject) =>
    assignee.kind === "user"
      ? subject.kind === "user" && subject.userId === assignee.userId
      : subject.kind === "team" && subject.teamId === assignee.teamId,
  );
  const reads = decide(access, { action: "read", environment: run.environment }, run).allowed;
  return { decide: assigned && reads, reassign };
}

/** Whether only the actor's instance role allowed `need`, not a grant: a privileged access. */
export function byInstanceRoleAlone(
  access: AccessGrants,
  need: Need,
  target: AccessTarget,
): boolean {
  return (
    isInstanceOperator(access) &&
    !decide({ ...access, instanceRole: "member" }, need, target).allowed
  );
}

export function sameSubject(left: Subject, right: Subject): boolean {
  switch (left.kind) {
    case "user":
      return right.kind === "user" && right.userId === left.userId;
    case "team":
      return right.kind === "team" && right.teamId === left.teamId;
    case "service-account":
      return right.kind === "service-account" && right.serviceAccountId === left.serviceAccountId;
  }
}

function roleFor(access: AccessGrants, need: Need, target: AccessTarget): ProjectRole | null {
  switch (need.action) {
    case "read":
    case "run":
    case "edit":
      return roleIn(access, target, need.environment);
    case "delete":
      return roleEverywhere(access, target);
    case "organize":
      return objectRole(access, target);
    case "administer":
      return projectRole(access, target.projectId);
  }
}

/** The highest project or automation role, before any environment caps it. */
function objectRole(access: AccessGrants, target: AccessTarget): ProjectRole | null {
  return capped(access.scope, unscopedObjectRole(access, target), target.projectId, null);
}

function unscopedObjectRole(access: AccessGrants, target: AccessTarget): ProjectRole | null {
  if (operatesInstance(access)) return "admin";
  return highest(
    access.grants.flatMap((grant) => {
      if (grant.on === "project" && grant.projectId === target.projectId) return [grant.role];
      // A share holds in the project the automation is in now, not over what it left behind.
      if (
        grant.on === "automation" &&
        grant.automationId === target.automationId &&
        grant.projectId === target.projectId
      ) {
        return [grant.role];
      }
      return [];
    }),
  );
}

function roleIn(
  access: AccessGrants,
  target: AccessTarget,
  environment: string,
): ProjectRole | null {
  return capped(
    access.scope,
    unscopedRoleIn(access, target, environment),
    target.projectId,
    environment,
  );
}

function unscopedRoleIn(
  access: AccessGrants,
  target: AccessTarget,
  environment: string,
): ProjectRole | null {
  const role = unscopedObjectRole(access, target);
  if (role === null || role === "admin" || !isProtected(access, target.projectId, environment)) {
    return role;
  }
  const cap = environmentCap(access, target.projectId, environment);
  return cap === null ? null : lowest(role, cap);
}

/** The role every environment allows: what changing all of them at once needs. */
function roleEverywhere(access: AccessGrants, target: AccessTarget): ProjectRole | null {
  // A token limited to some environments cannot change all of them.
  if (access.scope !== null && access.scope.environments !== null) return null;
  let role = objectRole(access, target);
  for (const { environment, projectId } of access.protectedEnvironments) {
    if (role === null) return null;
    if (projectId !== target.projectId) continue;
    const capped = roleIn(access, target, environment);
    role = capped === null ? null : lowest(role, capped);
  }
  return role;
}

function operatesInstance(access: AccessGrants): boolean {
  return OPERATOR_ROLES.has(access.instanceRole);
}

/** Whether a scope caps nothing: no token, or a token minted with FULL_SCOPE. */
function unlimited(scope: TokenScope | null): boolean {
  return (
    scope === null ||
    (scope.role === "admin" && scope.projectIds === null && scope.environments === null)
  );
}

/** Whether a scope reaches a project (null: any) and an environment (null: none is involved). */
function withinScope(
  scope: TokenScope | null,
  projectId: string | null,
  environment: string | null,
): boolean {
  if (scope === null) return true;
  if (projectId !== null && scope.projectIds !== null && !scope.projectIds.includes(projectId)) {
    return false;
  }
  return (
    environment === null || scope.environments === null || scope.environments.includes(environment)
  );
}

/**
 * A role after the token's scope caps it; `environment` null asks about the project as a whole.
 * A token limited to some environments never administers the whole project, since that reaches
 * every environment: deleting it, granting in it, or unprotecting production.
 */
function capped(
  scope: TokenScope | null,
  role: ProjectRole | null,
  projectId: string,
  environment: string | null,
): ProjectRole | null {
  if (scope === null || role === null) return role;
  if (!withinScope(scope, projectId, environment)) return null;
  const ceiling =
    environment === null && scope.environments !== null ? lowest(scope.role, "editor") : scope.role;
  return lowest(role, ceiling);
}

function isProtected(access: AccessGrants, projectId: string, environment: string): boolean {
  return access.protectedEnvironments.some(
    (entry) => entry.projectId === projectId && entry.environment === environment,
  );
}

/** The grants that bear on a target, so a refusal can say where the actor's role comes from. */
function sourcesFor(
  access: AccessGrants,
  target: AccessTarget,
  environment: string | null,
): readonly Grant[] {
  return access.grants.filter((grant) => {
    if (grant.projectId !== target.projectId) return false;
    if (grant.on === "automation") return grant.automationId === target.automationId;
    return grant.on === "project" || grant.environment === environment;
  });
}

function atLeast(role: ProjectRole, required: ProjectRole): boolean {
  return RANK[role] >= RANK[required];
}

function highest(roles: readonly ProjectRole[]): ProjectRole | null {
  return roles.reduce<ProjectRole | null>(
    (best, role) => (best === null || RANK[role] > RANK[best] ? role : best),
    null,
  );
}

function lowest(left: ProjectRole, right: ProjectRole): ProjectRole {
  return RANK[left] <= RANK[right] ? left : right;
}

/** Parse a role once where an untyped identity or audit row enters the domain. */
export function parseInstanceRole(value: unknown): InstanceRole {
  const role = INSTANCE_ROLES.find((role) => role === value);
  if (role === undefined) throw new Error(`Invalid instance role: ${String(value)}.`);
  return role;
}

export function parseProjectRole(value: unknown): ProjectRole {
  const role = PROJECT_ROLES.find((role) => role === value);
  if (role === undefined) throw new Error(`Invalid project role: ${String(value)}.`);
  return role;
}

/** A project role promised when an invitation is accepted. */
export interface PendingGrant {
  readonly projectId: string;
  readonly role: ProjectRole;
}
