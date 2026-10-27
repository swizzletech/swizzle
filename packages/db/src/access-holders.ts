/**
 * Who holds access to a project, or to one of its credentials, and what the policy in access.ts
 * gives each holder. Both lists come from one load of the project's grants: each holder's
 * AccessGrants are built here in memory, not read per holder. The API's Access tab
 * (apps/api/src/access-routes.ts) and a credential's access list (credential-routes.ts) answer
 * with them; the dashboard shows each holder with one row component.
 */
import {
  type AccessGrants,
  type CredentialGrant,
  type CredentialRight,
  type CredentialTarget,
  credentialRightBasis,
  environmentCap,
  environmentRole,
  type Grant,
  type InstanceRole,
  type ProjectRole,
  projectRole,
  type Subject,
  sameSubject,
} from "./access.js";
import type {
  AccessStore,
  ProjectAccess,
  StoredServiceAccount,
  StoredTeam,
} from "./access-store.js";

/** Who a holder is, as every holder list shows them. */
export interface Holder {
  readonly subject: Subject;
  /** The person's, team's or service account's name. */
  readonly name: string;
  /** The person's email; null for a team or a service account. */
  readonly email: string | null;
  /**
   * The instance role by which a person reaches every project, which a holder list shows as the
   * reason for their access. Null for a member, a team or a service account: grants alone explain
   * their access, so a list does not disclose their instance role.
   */
  readonly instanceRole: Exclude<InstanceRole, "member"> | null;
  /** A suspended person keeps their grants but may do nothing until reactivated. */
  readonly suspended: boolean;
  /** How many people a team has; null for a person or a service account. */
  readonly members: number | null;
}

/** What a holder may do in one environment. */
export interface EnvironmentHold {
  /** The role the policy gives them there, after a protected environment caps it. */
  readonly role: ProjectRole | null;
  /**
   * In a protected environment, the most their grants of it let a project role do there; null
   * elsewhere or without such a grant. A team's grant caps every member's role.
   */
  readonly cap: ProjectRole | null;
}

/** A grant that reaches a person through one of their teams. */
export interface TeamGrant {
  readonly grant: Grant & { readonly subject: Subject };
  readonly teamName: string;
}

/** A holder of access to a project, with what the policy gives them there. */
export interface ProjectHolder extends Holder {
  /** The role in the project as such; null when only shares or nothing reach it. */
  readonly role: ProjectRole | null;
  /** What they may do in each environment asked about. */
  readonly environments: Readonly<Record<string, EnvironmentHold>>;
  /** The grants that reach a person through their teams; empty for a team or service account. */
  readonly teamGrants: readonly TeamGrant[];
}

/** Where a holder's right on a credential comes from. */
export type CredentialRightSource =
  /** A grant that names the holder itself. */
  | { readonly kind: "grant"; readonly right: CredentialRight }
  /** A grant to a team the person is in. */
  | {
      readonly kind: "team";
      readonly right: CredentialRight;
      readonly teamId: string;
      readonly teamName: string;
    }
  /** Instance owners and admins, and admins of the owning project, hold it by role. */
  | { readonly kind: "role"; readonly role: "owner" | "admin" | "project-admin" };

/** A person, team or service account with a right on a credential, and every source of it. */
export interface CredentialHolder extends Holder {
  /** What the policy gives them; for a team, what its grant names. */
  readonly right: CredentialRight;
  readonly sources: readonly CredentialRightSource[];
}

/** A person as the holder lists need them. */
export interface HolderPerson {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: InstanceRole;
  readonly suspended: boolean;
}

/** Everything both lists read: one project's grants and the people, teams and accounts. */
export interface HolderDirectory {
  readonly access: ProjectAccess;
  readonly people: readonly HolderPerson[];
  readonly teams: readonly StoredTeam[];
  /** The project's own service accounts. */
  readonly serviceAccounts: readonly StoredServiceAccount[];
}

/** Reads a project's directory once: its grants, every person and team, and its accounts. */
export async function loadHolderDirectory(
  stores: {
    readonly accessStore: Pick<AccessStore, "listServiceAccounts" | "listTeams" | "projectAccess">;
    readonly people: { listPeople(): Promise<readonly HolderPerson[]> };
  },
  projectId: string,
): Promise<HolderDirectory | null> {
  const [access, people, teams, serviceAccounts] = await Promise.all([
    stores.accessStore.projectAccess(projectId),
    stores.people.listPeople(),
    stores.accessStore.listTeams(),
    stores.accessStore.listServiceAccounts(projectId),
  ]);
  return access === null ? null : { access, people, serviceAccounts, teams };
}

/**
 * Everyone a project's Access tab lists: the people who reach it by instance role, grant or team,
 * the teams with a grant in it and its service accounts, each with their role in the project and
 * in each of `environments`.
 */
export function projectHolders(
  directory: HolderDirectory,
  environments: readonly string[],
): ProjectHolder[] {
  const { access, people, serviceAccounts, teams } = directory;
  const projectId = access.project.id;
  const named = namedIn(access.grants);
  const grantedTeams = teams.filter((team) => named({ kind: "team", teamId: team.id }));
  const holding = (
    holder: Holder,
    grants: AccessGrants,
    teamGrants: readonly TeamGrant[] = [],
  ): ProjectHolder => ({
    ...holder,
    environments: Object.fromEntries(
      environments.map((environment) => [
        environment,
        {
          cap: environmentCap(grants, projectId, environment),
          role: environmentRole(grants, projectId, environment),
        },
      ]),
    ),
    role: projectRole(grants, projectId),
    teamGrants,
  });
  const throughTeams = (person: HolderPerson) =>
    grantedTeams.flatMap((team) =>
      team.memberIds.includes(person.id)
        ? access.grants
            .filter((grant) => sameSubject(grant.subject, teamSubject(team)))
            .map((grant) => ({ grant, teamName: team.name }))
        : [],
    );
  return [
    ...reaching(people, named, grantedTeams).map((person) =>
      holding(personHolder(person), personGrants(directory, person), throughTeams(person)),
    ),
    // A team is no actor: its roles are what its own grants give any member.
    ...grantedTeams.map((team) =>
      holding(teamHolder(team), grantsOf(access, "member", [teamSubject(team)])),
    ),
    ...serviceAccounts.map((account) =>
      holding(accountHolder(account), grantsOf(access, "member", [accountSubject(account)])),
    ),
  ];
}

/**
 * Everyone with a right on a credential of the directory's project: each person and service
 * account the policy gives one, and each team a grant names, with every source of the right.
 */
export function credentialHolders(
  directory: HolderDirectory,
  credential: CredentialTarget,
  grants: readonly CredentialGrant[],
): CredentialHolder[] {
  const { access, people, serviceAccounts, teams } = directory;
  const named = namedIn([...grants, ...access.grants]);
  const namedTeams = teams.filter((team) => named({ kind: "team", teamId: team.id }));
  const holding = (holder: Holder, held: AccessGrants): CredentialHolder[] => {
    const basis = credentialRightBasis(held, credential, grants);
    if (basis.right === null) return [];
    const sources: CredentialRightSource[] = [
      ...(basis.role === null ? [] : [{ kind: "role", role: basis.role } as const]),
      ...basis.grants.map(({ right, subject }): CredentialRightSource => {
        if (subject.kind !== "team" || sameSubject(subject, holder.subject)) {
          return { kind: "grant", right };
        }
        const team = teams.find((candidate) => candidate.id === subject.teamId);
        return { kind: "team", right, teamId: subject.teamId, teamName: team?.name ?? "a team" };
      }),
    ];
    return [{ ...holder, right: basis.right, sources }];
  };
  return [
    ...reaching(people, named, namedTeams).flatMap((person) =>
      holding(personHolder(person), personGrants(directory, person)),
    ),
    // A team is no actor: it holds what its own grant names, and each member as their role allows.
    ...teams.flatMap((team): CredentialHolder[] => {
      const grant = grants.find((candidate) => sameSubject(candidate.subject, teamSubject(team)));
      return grant === undefined
        ? []
        : [
            {
              ...teamHolder(team),
              right: grant.right,
              sources: [{ kind: "grant", right: grant.right }],
            },
          ];
    }),
    ...serviceAccounts
      .filter((account) => named(accountSubject(account)))
      .flatMap((account) =>
        holding(accountHolder(account), grantsOf(access, "member", [accountSubject(account)])),
      ),
  ];
}

/** A person's grants in the project, their own and their teams', as loadGrants would read them. */
function personGrants(directory: HolderDirectory, person: HolderPerson): AccessGrants {
  return grantsOf(directory.access, person.role, [
    personSubject(person),
    ...directory.teams
      .filter((team) => team.memberIds.includes(person.id))
      .map((team) => teamSubject(team)),
  ]);
}

function grantsOf(
  access: ProjectAccess,
  instanceRole: InstanceRole,
  subjects: readonly Subject[],
): AccessGrants {
  return {
    grants: access.grants.flatMap(({ subject, ...grant }) =>
      subjects.some((candidate) => sameSubject(candidate, subject)) ? [grant] : [],
    ),
    instanceRole,
    protectedEnvironments: access.protectedEnvironments.map((environment) => ({
      environment,
      projectId: access.project.id,
    })),
    scope: null,
    subjects,
  };
}

/** The people a list shows: instance owners and admins, and members a grant names or a team's reaches. */
function reaching(
  people: readonly HolderPerson[],
  named: (subject: Subject) => boolean,
  namedTeams: readonly StoredTeam[],
): readonly HolderPerson[] {
  return people.filter(
    (person) =>
      person.role !== "member" ||
      named(personSubject(person)) ||
      namedTeams.some((team) => team.memberIds.includes(person.id)),
  );
}

function namedIn(grants: readonly { readonly subject: Subject }[]) {
  return (subject: Subject) => grants.some((grant) => sameSubject(grant.subject, subject));
}

function personHolder(person: HolderPerson): Holder {
  return {
    email: person.email,
    instanceRole: person.role === "member" ? null : person.role,
    members: null,
    name: person.name,
    subject: personSubject(person),
    suspended: person.suspended,
  };
}

function teamHolder(team: StoredTeam): Holder {
  return {
    email: null,
    instanceRole: null,
    members: team.memberIds.length,
    name: team.name,
    subject: teamSubject(team),
    suspended: false,
  };
}

function accountHolder(account: StoredServiceAccount): Holder {
  return {
    email: null,
    instanceRole: null,
    members: null,
    name: account.name,
    subject: accountSubject(account),
    suspended: false,
  };
}

const personSubject = (person: { readonly id: string }) =>
  ({ kind: "user", userId: person.id }) as const;
const teamSubject = (team: { readonly id: string }) => ({ kind: "team", teamId: team.id }) as const;
const accountSubject = (account: { readonly id: string }) =>
  ({ kind: "service-account", serviceAccountId: account.id }) as const;

/** The access response, built from the same directory as its holder policy. */
export function projectAccessView(directory: HolderDirectory, environments: readonly string[]) {
  return { ...directory.access, environments, holders: projectHolders(directory, environments) };
}

export type ProjectAccessView = ReturnType<typeof projectAccessView>;
