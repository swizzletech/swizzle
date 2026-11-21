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

export interface Holder {
  readonly subject: Subject;
  readonly name: string;
  readonly email: string | null;
  readonly instanceRole: Exclude<InstanceRole, "member"> | null;
  readonly suspended: boolean;
  readonly members: number | null;
}

export interface EnvironmentHold {
  readonly role: ProjectRole | null;
  readonly cap: ProjectRole | null;
}

export interface TeamGrant {
  readonly grant: Grant & { readonly subject: Subject };
  readonly teamName: string;
}

export interface ProjectHolder extends Holder {
  readonly role: ProjectRole | null;
  readonly environments: Readonly<Record<string, EnvironmentHold>>;
  readonly teamGrants: readonly TeamGrant[];
}

export type CredentialRightSource =
  | { readonly kind: "grant"; readonly right: CredentialRight }
  | {
      readonly kind: "team";
      readonly right: CredentialRight;
      readonly teamId: string;
      readonly teamName: string;
    }
  | { readonly kind: "role"; readonly role: "owner" | "admin" | "project-admin" };

export interface CredentialHolder extends Holder {
  readonly right: CredentialRight;
  readonly sources: readonly CredentialRightSource[];
}

export interface HolderPerson {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: InstanceRole;
  readonly suspended: boolean;
}

export interface HolderDirectory {
  readonly access: ProjectAccess;
  readonly people: readonly HolderPerson[];
  readonly teams: readonly StoredTeam[];
  readonly serviceAccounts: readonly StoredServiceAccount[];
}

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
    ...grantedTeams.map((team) =>
      holding(teamHolder(team), grantsOf(access, "member", [teamSubject(team)])),
    ),
    ...serviceAccounts.map((account) =>
      holding(accountHolder(account), grantsOf(access, "member", [accountSubject(account)])),
    ),
  ];
}

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

export function projectAccessView(directory: HolderDirectory, environments: readonly string[]) {
  return { ...directory.access, environments, holders: projectHolders(directory, environments) };
}

export type ProjectAccessView = ReturnType<typeof projectAccessView>;
