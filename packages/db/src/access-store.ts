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

export interface PersonOnRecord {
  readonly id: string;
  readonly name: string;
}

export interface StoredServiceAccount {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdBy: PersonOnRecord;
  readonly createdAt: string;
}

export type GrantHolder =
  | { readonly kind: "user"; readonly userId: string; readonly instanceRole: InstanceRole }
  | { readonly kind: "service-account"; readonly serviceAccountId: string };

export interface StoredTeam {
  readonly id: string;
  readonly name: string;
  readonly memberIds: readonly string[];
  readonly createdAt: string;
}

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

export interface ProjectAccess {
  readonly project: StoredProject;
  readonly protectedEnvironments: readonly string[];
  readonly grants: readonly (Grant & { readonly subject: Subject })[];
  readonly automationSlugs: Readonly<Record<string, string>>;
}

export interface PeopleDirectory {
  readonly users: readonly Pick<AuthUser, "id" | "name" | "email">[];
  readonly teams: readonly Pick<StoredTeam, "id" | "name">[];
}

export interface AccessStore {
  directory(projectIds: readonly string[] | "all"): Promise<PeopleDirectory>;
  loadGrants(holder: GrantHolder): Promise<AccessGrants>;
  listProjects(): Promise<readonly ListedProject[]>;
  getProject(reference: string): Promise<StoredProject | null>;
  createProject(input: { readonly slug: string; readonly name: string }): Promise<StoredProject>;
  projectAccess(projectId: string): Promise<ProjectAccess | null>;
  setGrant(subject: Subject, target: GrantTarget): Promise<ProjectRole | null>;
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
  setTeamMember(teamId: string, userId: string, member: boolean): Promise<boolean>;
  listServiceAccounts(projectId: string): Promise<readonly StoredServiceAccount[]>;
  getServiceAccount(projectId: string, reference: string): Promise<StoredServiceAccount | null>;
  findServiceAccount(serviceAccountId: string): Promise<StoredServiceAccount | null>;
  createServiceAccount(input: {
    readonly projectId: string;
    readonly name: string;
    readonly createdBy: PersonOnRecord;
  }): Promise<StoredServiceAccount>;
  deleteServiceAccount(serviceAccountId: string): Promise<boolean>;
  close(): Promise<void>;
}

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
