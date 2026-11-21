import type { ApprovalAssignee } from "./run-approval.js";

export const PROJECT_ROLES = ["viewer", "operator", "editor", "admin"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export type ShareRole = Exclude<ProjectRole, "admin">;

export const INSTANCE_ROLES = ["owner", "admin", "member"] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

export const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
export const PROTECTED_BY_DEFAULT = "production";
export const RELEASE_TEAM_ID = "00000000-0000-4000-8000-000000000002";
export const RELEASE_ROLE: ShareRole = "editor";

export type Subject =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "team"; readonly teamId: string }
  | { readonly kind: "service-account"; readonly serviceAccountId: string };

export interface TokenScope {
  readonly role: ProjectRole;
  readonly projectIds: readonly string[] | null;
  readonly environments: readonly string[] | null;
}

export const FULL_SCOPE: TokenScope = { environments: null, projectIds: null, role: "admin" };

export const SERVICE_ACCOUNT_MAX_ROLE: ShareRole = "editor";

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

export interface AccessGrants {
  readonly instanceRole: InstanceRole;
  readonly subjects: readonly Subject[];
  readonly grants: readonly Grant[];
  readonly protectedEnvironments: readonly {
    readonly projectId: string;
    readonly environment: string;
  }[];
  readonly scope: TokenScope | null;
}

export interface AccessTarget {
  readonly automationId: string | null;
  readonly projectId: string;
}

export type Need =
  | { readonly action: "read" | "run" | "edit"; readonly environment: string }
  | { readonly action: "delete" }
  | { readonly action: "organize" }
  | { readonly action: "administer" };

export type Decision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly visible: boolean;
      readonly role: ProjectRole | null;
      readonly required: ProjectRole;
      readonly sources: readonly Grant[];
      readonly scope: TokenScope | null;
      readonly protectedEnvironment: string | null;
    };

export type AccessRefusal = Omit<Extract<Decision, { allowed: false }>, "allowed" | "visible">;

export function refusalOf(decision: Extract<Decision, { allowed: false }>): AccessRefusal {
  const { protectedEnvironment, required, role, scope, sources } = decision;
  return { protectedEnvironment, required, role, scope, sources };
}

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
export type CredentialRight = (typeof CREDENTIAL_RIGHTS)[number];

export interface CredentialTarget {
  readonly kind: CredentialKind;
  readonly id: string;
  readonly projectId: string;
  readonly environment: string;
}

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

export function isInstanceOperator(access: AccessGrants): boolean {
  return operatesInstance(access) && unlimited(access.scope);
}

export function reachedProjects(access: AccessGrants): readonly string[] | "all" {
  if (operatesInstance(access)) return access.scope?.projectIds ?? "all";
  const projectIds = access.grants.flatMap((grant) =>
    grant.on === "project" && withinScope(access.scope, grant.projectId, null)
      ? [grant.projectId]
      : [],
  );
  return [...new Set(projectIds)];
}

export interface AuditView {
  readonly projectIds: readonly string[] | null;
  readonly environments: readonly string[] | null;
  readonly ownOnly: boolean;
}

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

export function environmentRole(
  access: AccessGrants,
  projectId: string,
  environment: string,
): ProjectRole | null {
  return roleIn(access, { automationId: null, projectId }, environment);
}

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

export interface CredentialRightBasis {
  readonly right: CredentialRight | null;
  readonly role: "owner" | "admin" | "project-admin" | null;
  readonly grants: readonly CredentialGrant[];
}

export function credentialRight(
  access: AccessGrants,
  credential: CredentialTarget,
  grants: readonly CredentialGrant[],
): CredentialRight | null {
  return credentialRightBasis(access, credential, grants).right;
}

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

function roleHolding(
  access: AccessGrants,
  owner: AccessTarget,
  environment: string,
): CredentialRightBasis["role"] {
  if (access.instanceRole !== "member") return access.instanceRole;
  if (unscopedRoleIn(access, owner, environment) === "admin") return "project-admin";
  return null;
}

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

function objectRole(access: AccessGrants, target: AccessTarget): ProjectRole | null {
  return capped(access.scope, unscopedObjectRole(access, target), target.projectId, null);
}

function unscopedObjectRole(access: AccessGrants, target: AccessTarget): ProjectRole | null {
  if (operatesInstance(access)) return "admin";
  return highest(
    access.grants.flatMap((grant) => {
      if (grant.on === "project" && grant.projectId === target.projectId) return [grant.role];
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

function roleEverywhere(access: AccessGrants, target: AccessTarget): ProjectRole | null {
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

function unlimited(scope: TokenScope | null): boolean {
  return (
    scope === null ||
    (scope.role === "admin" && scope.projectIds === null && scope.environments === null)
  );
}

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

export interface PendingGrant {
  readonly projectId: string;
  readonly role: ProjectRole;
}
