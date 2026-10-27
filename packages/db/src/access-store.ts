/**
 * The contract of the store for projects, teams and the grants on them (ADR 0014); access-tables.ts
 * implements it. The API reads `loadGrants` once per request and hands the result to access.ts;
 * the management routes write the rest. People and their instance role live in Better Auth's
 * tables (auth.ts); every person id here is one of theirs.
 */
import type {
  AccessGrants,
  Grant,
  InstanceRole,
  ProjectRole,
  ShareRole,
  Subject,
} from "./access.js";

import type { AuthUser } from "./auth-types.js";

export interface StoredProject {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface ListedProject extends StoredProject {
  readonly protectedEnvironments: readonly string[];
}

/**
 * Who created or issued something, by id and by their name at the time. Both stay after the
 * person is removed, as an audit event's actor does.
 */
export interface PersonOnRecord {
  readonly id: string;
  readonly name: string;
}

/**
 * A project's own identity for an agent or an integration (CONTEXT.md, Service account). It is
 * deleted with its project, never with the person who created it.
 */
export interface StoredServiceAccount {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdBy: PersonOnRecord;
  readonly createdAt: string;
}

/** Whom `loadGrants` reads for: a person with their instance role, or a service account. */
export type GrantHolder =
  | { readonly kind: "user"; readonly userId: string; readonly instanceRole: InstanceRole }
  | { readonly kind: "service-account"; readonly serviceAccountId: string };

export interface StoredTeam {
  readonly id: string;
  readonly name: string;
  readonly memberIds: readonly string[];
  readonly createdAt: string;
}

/** Where a grant applies, with the role type that place allows. */
export type GrantTarget =
  | { readonly on: "project"; readonly projectId: string; readonly role: ProjectRole }
  | {
      readonly on: "automation";
      readonly automationId: string;
      readonly automationSlug: string;
      readonly projectId: string;
      readonly role: ShareRole;
    }
  | {
      readonly on: "environment";
      readonly projectId: string;
      readonly environment: string;
      readonly role: ShareRole;
    };

export type GrantPlace =
  | { readonly on: "project"; readonly projectId: string }
  | {
      readonly on: "automation";
      readonly automationId: string;
      readonly automationSlug: string;
      readonly projectId: string;
    }
  | { readonly on: "environment"; readonly projectId: string; readonly environment: string };

/** Every grant in a project, with its subject, for the people who administer it. */
export interface ProjectAccess {
  readonly project: StoredProject;
  readonly protectedEnvironments: readonly string[];
  readonly grants: readonly (Grant & { readonly subject: Subject })[];
  /** The slug of each automation a grant names, by id, since grant routes name it by slug. */
  readonly automationSlugs: Readonly<Record<string, string>>;
}

/** Minimal identities for assignment and sharing, without account or membership state. */
export interface PeopleDirectory {
  readonly users: readonly Pick<AuthUser, "id" | "name" | "email">[];
  readonly teams: readonly Pick<StoredTeam, "id" | "name">[];
}

export interface AccessStore {
  directory(projectIds: readonly string[] | "all"): Promise<PeopleDirectory>;
  /**
   * The grants that reach a person directly or through a team, or a service account; `scope` is
   * null, the caller sets the token's.
   */
  loadGrants(holder: GrantHolder): Promise<AccessGrants>;
  /** Every project with the environments it protects. */
  listProjects(): Promise<readonly ListedProject[]>;
  /** By id or slug. */
  getProject(reference: string): Promise<StoredProject | null>;
  /**
   * The project starts with PROTECTED_BY_DEFAULT protected and granted to the team Release
   * (RELEASE_TEAM_ID) as RELEASE_ROLE, while that team exists.
   */
  createProject(input: { readonly slug: string; readonly name: string }): Promise<StoredProject>;
  // Deleting a project decides about its automations, credentials and runs, so it lives on the
  // ControlPlaneStore (deleteProject), which owns them.
  projectAccess(projectId: string): Promise<ProjectAccess | null>;
  /** The role replaced by this write, or null when it created a grant. */
  setGrant(subject: Subject, target: GrantTarget): Promise<ProjectRole | null>;
  /** False when there was no such grant. */
  removeGrant(subject: Subject, place: GrantPlace): Promise<boolean>;
  setEnvironmentProtected(
    projectId: string,
    environment: string,
    isProtected: boolean,
    confirmation: "confirmed" | "required",
  ): Promise<{ readonly changed: boolean; readonly grantsRemoved: number }>;
  listTeams(): Promise<readonly StoredTeam[]>;
  createTeam(name: string): Promise<StoredTeam>;
  deleteTeam(teamId: string): Promise<boolean>;
  /** Whether membership changed. A missing team is an error. */
  setTeamMember(teamId: string, userId: string, member: boolean): Promise<boolean>;
  listServiceAccounts(projectId: string): Promise<readonly StoredServiceAccount[]>;
  /** By id or name, in the project. */
  getServiceAccount(projectId: string, reference: string): Promise<StoredServiceAccount | null>;
  /** By id in any project, for the token that acts as it. */
  findServiceAccount(serviceAccountId: string): Promise<StoredServiceAccount | null>;
  createServiceAccount(input: {
    readonly projectId: string;
    readonly name: string;
    readonly createdBy: PersonOnRecord;
  }): Promise<StoredServiceAccount>;
  /** Deletes its grants and tokens with it. False when there was no such account. */
  deleteServiceAccount(serviceAccountId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** A subject reference at the API boundary; the server resolves its name or id. */
export type SubjectReference =
  | { readonly user: string }
  | { readonly team: string }
  | { readonly serviceAccount: string };
export type GrantQuery = Partial<{
  readonly user: string;
  readonly team: string;
  readonly serviceAccount: string;
  readonly environment: string;
  readonly automation: string;
}>;
export type SetGrantBody = GrantQuery & { readonly role: ProjectRole };
export interface GrantWriteResult {
  readonly project: string;
  readonly subject: string;
  readonly role: ProjectRole;
  readonly previousRole: ProjectRole | null;
}
export interface GrantRemovalResult {
  readonly project: string;
  readonly subject: string;
  readonly changed: boolean;
}
export interface ProtectionResult {
  readonly project: string;
  readonly environment: string;
  readonly changed: boolean;
  readonly grantsRemoved: number;
}
export interface MembershipResult {
  readonly team: string;
  readonly person: string;
  readonly changed: boolean;
}
export type VisibleProject = ListedProject & { readonly role: ProjectRole };

export type CreateProjectResult = StoredProject & { readonly changed: boolean };
export type CreateTeamResult = StoredTeam & { readonly changed: boolean };
export interface DeleteTeamResult {
  readonly team: string;
  readonly changed: boolean;
}
export interface DeleteServiceAccountResult {
  readonly serviceAccount: string;
  readonly changed: boolean;
}
