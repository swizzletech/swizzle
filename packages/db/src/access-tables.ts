import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  type Grant,
  type GrantVia,
  PROTECTED_BY_DEFAULT,
  RELEASE_ROLE,
  RELEASE_TEAM_ID,
  type Subject,
} from "./access.js";
import type {
  AccessStore,
  GrantHolder,
  StoredProject,
  StoredServiceAccount,
  StoredTeam,
} from "./access-store.js";
import { causeCode, createDatabaseClient, type DatabaseClient, PG_ERROR } from "./client.js";
import { CodedError } from "./coded-error.js";
import { namesSubject, subjectOfRow, subjectValues } from "./grant-subject.js";
import {
  grants as accessGrants,
  authUsers,
  automations,
  projects,
  protectedEnvironments,
  serviceAccounts,
  teamMembers,
  teams,
} from "./schema.js";

const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const NAME_MAX = { project: 120, "service account": 80, team: 80 } as const;

export function createPostgresAccessStore(
  options: { readonly client?: DatabaseClient; readonly connectionString?: string } = {},
): AccessStore {
  const client =
    options.client ??
    createDatabaseClient(
      options.connectionString !== undefined ? { connectionString: options.connectionString } : {},
    );
  const ownsClient = options.client === undefined;
  const { db } = client;

  return {
    async close() {
      if (ownsClient) await client.close();
    },

    async loadGrants(holder) {
      const memberships =
        holder.kind === "user"
          ? await db
              .select({ teamId: teams.id, teamName: teams.name })
              .from(teamMembers)
              .innerJoin(teams, eq(teams.id, teamMembers.teamId))
              .where(eq(teamMembers.userId, holder.userId))
          : [];
      const subjects = holderSubjects(
        holder,
        memberships.map((team) => team.teamId),
      );
      const rows = await db
        .select()
        .from(accessGrants)
        .where(or(...subjects.map((subject) => namesSubject(accessGrants, subject))));
      const via = viaTeam(memberships);
      const grants = rows.map((row) => grantOfRow(row, via(row.teamId)));
      const projectIds = [...new Set(grants.map((grant) => grant.projectId))];
      const protectedRows =
        projectIds.length === 0
          ? []
          : await db
              .select({
                environment: protectedEnvironments.environment,
                projectId: protectedEnvironments.projectId,
              })
              .from(protectedEnvironments)
              .where(inArray(protectedEnvironments.projectId, projectIds));
      return {
        grants,
        instanceRole: holder.kind === "user" ? holder.instanceRole : "member",
        protectedEnvironments: protectedRows,
        scope: null,
        subjects,
      };
    },

    async listProjects() {
      const [rows, protectedRows] = await Promise.all([
        db.select().from(projects).orderBy(asc(projects.name)),
        db
          .select({
            environment: protectedEnvironments.environment,
            projectId: protectedEnvironments.projectId,
          })
          .from(protectedEnvironments)
          .orderBy(asc(protectedEnvironments.environment)),
      ]);
      return rows.map((row) => ({
        ...projectView(row),
        protectedEnvironments: protectedRows
          .filter((entry) => entry.projectId === row.id)
          .map((entry) => entry.environment),
      }));
    },

    async getProject(reference) {
      const [row] = await db
        .select()
        .from(projects)
        .where(isUuid(reference) ? eq(projects.id, reference) : eq(projects.slug, reference))
        .limit(1);
      return row === undefined ? null : projectView(row);
    },

    async createProject(input) {
      const { name, slug } = validProject(input);
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx.insert(projects).values({ name, slug }).returning();
          if (row === undefined) throw new Error("The project was not inserted.");
          await tx
            .insert(protectedEnvironments)
            .values({ environment: PROTECTED_BY_DEFAULT, projectId: row.id });
          // The share lock keeps the team from being deleted before its grant is in.
          const [release] = await tx
            .select({ id: teams.id })
            .from(teams)
            .where(eq(teams.id, RELEASE_TEAM_ID))
            .for("share");
          if (release !== undefined) {
            await tx.insert(accessGrants).values({
              on: "environment",
              environment: PROTECTED_BY_DEFAULT,
              projectId: row.id,
              role: RELEASE_ROLE,
              teamId: release.id,
            });
          }
          return projectView(row);
        });
      } catch (error) {
        if (causeCode(error) === PG_ERROR.uniqueViolation) throw slugConflict(slug);
        throw error;
      }
    },

    async projectAccess(projectId) {
      const [projectRow] = await db.select().from(projects).where(eq(projects.id, projectId));
      if (projectRow === undefined) return null;
      const [protectedRows, rows, teamRows, automationRows] = await Promise.all([
        db
          .select({ environment: protectedEnvironments.environment })
          .from(protectedEnvironments)
          .where(eq(protectedEnvironments.projectId, projectId))
          .orderBy(asc(protectedEnvironments.environment)),
        db.select().from(accessGrants).where(eq(accessGrants.projectId, projectId)),
        db.select({ id: teams.id, name: teams.name }).from(teams),
        db
          .select({ id: automations.id, slug: automations.slug })
          .from(automations)
          .where(eq(automations.projectId, projectId)),
      ]);
      const via = viaTeam(teamRows.map((team) => ({ teamId: team.id, teamName: team.name })));
      return {
        grants: rows.map((row) => ({
          ...grantOfRow(row, via(row.teamId)),
          subject: subjectOfRow(row),
        })),
        automationSlugs: Object.fromEntries(automationRows.map((row) => [row.id, row.slug])),
        project: projectView(projectRow),
        protectedEnvironments: protectedRows.map((row) => row.environment),
      };
    },

    async setGrant(subject, target) {
      try {
        return await db.transaction(async (tx) => {
          // Every grant/protection write locks its project, including the first grant with no row yet.
          await tx
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, target.projectId))
            .for("update");
          const [previous] = await tx
            .select({ role: accessGrants.role })
            .from(accessGrants)
            .where(
              and(
                eq(accessGrants.on, target.on),
                eq(accessGrants.projectId, target.projectId),
                target.on === "automation"
                  ? eq(accessGrants.automationId, target.automationId)
                  : undefined,
                target.on === "environment"
                  ? eq(accessGrants.environment, target.environment)
                  : undefined,
                namesSubject(accessGrants, subject),
              ),
            );
          await tx
            .insert(accessGrants)
            .values({
              ...subjectValues(subject),
              on: target.on,
              projectId: target.projectId,
              automationId: target.on === "automation" ? target.automationId : null,
              environment: target.on === "environment" ? target.environment : null,
              role: target.role,
            })
            .onConflictDoUpdate({
              target: [
                accessGrants.on,
                accessGrants.projectId,
                accessGrants.automationId,
                accessGrants.environment,
                accessGrants.userId,
                accessGrants.teamId,
                accessGrants.serviceAccountId,
              ],
              set: { role: target.role },
            });
          return previous?.role ?? null;
        });
      } catch (error) {
        if (target.on === "environment" && causeCode(error) === PG_ERROR.foreignKeyViolation) {
          throw environmentNotProtected(target.environment);
        }
        throw error;
      }
    },

    async removeGrant(subject, place) {
      return await db.transaction(async (tx) => {
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, place.projectId))
          .for("update");
        const removed = await tx
          .delete(accessGrants)
          .where(
            and(
              eq(accessGrants.on, place.on),
              eq(accessGrants.projectId, place.projectId),
              place.on === "automation"
                ? eq(accessGrants.automationId, place.automationId)
                : undefined,
              place.on === "environment"
                ? eq(accessGrants.environment, place.environment)
                : undefined,
              namesSubject(accessGrants, subject),
            ),
          )
          .returning({ id: accessGrants.id });
        return removed.length > 0;
      });
    },

    async setEnvironmentProtected(projectId, environment, isProtected, confirmation) {
      return await db.transaction(async (tx) => {
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, projectId))
          .for("update");
        if (isProtected) {
          const inserted = await tx
            .insert(protectedEnvironments)
            .values({ environment, projectId })
            .onConflictDoNothing()
            .returning({ projectId: protectedEnvironments.projectId });
          return { changed: inserted.length > 0, grantsRemoved: 0 };
        }
        const grants = await tx
          .select({ id: accessGrants.id })
          .from(accessGrants)
          .where(
            and(
              eq(accessGrants.projectId, projectId),
              eq(accessGrants.on, "environment"),
              eq(accessGrants.environment, environment),
            ),
          );
        if (confirmation === "required") {
          const [held] = await tx
            .select({ projectId: protectedEnvironments.projectId })
            .from(protectedEnvironments)
            .where(
              and(
                eq(protectedEnvironments.projectId, projectId),
                eq(protectedEnvironments.environment, environment),
              ),
            );
          if (held !== undefined)
            throw new CodedError(
              "CONFIRMATION_REQUIRED",
              `Removing protection deletes ${grants.length} ${grants.length === 1 ? "grant" : "grants"}; project grants reach it again.`,
              { details: { grantsRemoved: grants.length } },
            );
        }
        const deleted = await tx
          .delete(protectedEnvironments)
          .where(
            and(
              eq(protectedEnvironments.projectId, projectId),
              eq(protectedEnvironments.environment, environment),
            ),
          )
          .returning({ projectId: protectedEnvironments.projectId });
        return { changed: deleted.length > 0, grantsRemoved: grants.length };
      });
    },

    async directory(projectIds) {
      if (projectIds !== "all" && projectIds.length === 0) return { users: [], teams: [] };
      const sharedTeams = db
        .select({ id: accessGrants.teamId })
        .from(accessGrants)
        .where(projectIds === "all" ? undefined : inArray(accessGrants.projectId, projectIds));
      const sharedUsers = db
        .select({ id: accessGrants.userId })
        .from(accessGrants)
        .where(projectIds === "all" ? undefined : inArray(accessGrants.projectId, projectIds));
      const teamUsers = db
        .select({ id: teamMembers.userId })
        .from(teamMembers)
        .where(inArray(teamMembers.teamId, sharedTeams));
      const [users, directoryTeams] = await Promise.all([
        db
          .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
          .from(authUsers)
          .where(
            and(
              isNull(authUsers.suspendedAt),
              projectIds === "all"
                ? undefined
                : or(
                    inArray(authUsers.role, ["owner", "admin"]),
                    inArray(authUsers.id, sharedUsers),
                    inArray(authUsers.id, teamUsers),
                  ),
            ),
          )
          .orderBy(asc(authUsers.name), asc(authUsers.id)),
        db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(projectIds === "all" ? undefined : inArray(teams.id, sharedTeams))
          .orderBy(asc(teams.name)),
      ]);
      return { users, teams: directoryTeams };
    },

    async listTeams() {
      const [teamRows, memberRows] = await Promise.all([
        db.select().from(teams).orderBy(asc(teams.name)),
        db.select({ teamId: teamMembers.teamId, userId: teamMembers.userId }).from(teamMembers),
      ]);
      return teamRows.map((team) =>
        teamView(
          team,
          memberRows.filter((member) => member.teamId === team.id).map((member) => member.userId),
        ),
      );
    },

    async createTeam(name) {
      const valid = validName("team", name);
      try {
        const [row] = await db
          .insert(teams)
          .values({ name: valid, normalizedName: valid.toLowerCase() })
          .returning();
        if (row === undefined) throw new Error("The team was not inserted.");
        return teamView(row, []);
      } catch (error) {
        if (causeCode(error) === PG_ERROR.uniqueViolation) throw teamConflict(valid);
        throw error;
      }
    },

    async deleteTeam(teamId) {
      const deleted = await db
        .delete(teams)
        .where(eq(teams.id, teamId))
        .returning({ id: teams.id });
      return deleted.length > 0;
    },

    async setTeamMember(teamId, userId, member) {
      return await db.transaction(async (tx) => {
        const [team] = await tx
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.id, teamId))
          .for("key share");
        if (team === undefined) throw new CodedError("TEAM_NOT_FOUND", "No such team.");
        if (member) {
          const inserted = await tx
            .insert(teamMembers)
            .values({ teamId, userId })
            .onConflictDoNothing()
            .returning({ userId: teamMembers.userId });
          return inserted.length > 0;
        }
        const deleted = await tx
          .delete(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
          .returning({ userId: teamMembers.userId });
        return deleted.length > 0;
      });
    },

    async listServiceAccounts(projectId) {
      const rows = await db
        .select()
        .from(serviceAccounts)
        .where(eq(serviceAccounts.projectId, projectId))
        .orderBy(asc(serviceAccounts.name));
      return rows.map(serviceAccountView);
    },

    async getServiceAccount(projectId, reference) {
      const [row] = await db
        .select()
        .from(serviceAccounts)
        .where(
          and(
            eq(serviceAccounts.projectId, projectId),
            isUuid(reference)
              ? eq(serviceAccounts.id, reference)
              : eq(serviceAccounts.normalizedName, reference.trim().toLowerCase()),
          ),
        );
      return row === undefined ? null : serviceAccountView(row);
    },

    async findServiceAccount(serviceAccountId) {
      const [row] = await db
        .select()
        .from(serviceAccounts)
        .where(eq(serviceAccounts.id, serviceAccountId));
      return row === undefined ? null : serviceAccountView(row);
    },

    async createServiceAccount({ createdBy, name, projectId }) {
      const valid = validServiceAccountName(name);
      try {
        const [row] = await db
          .insert(serviceAccounts)
          .values({
            createdBy: createdBy.id,
            createdByName: createdBy.name,
            name: valid,
            normalizedName: valid.toLowerCase(),
            projectId,
          })
          .returning();
        if (row === undefined) throw new Error("The service account was not inserted.");
        return serviceAccountView(row);
      } catch (error) {
        if (causeCode(error) === PG_ERROR.uniqueViolation) throw serviceAccountConflict(valid);
        throw error;
      }
    },

    async deleteServiceAccount(serviceAccountId) {
      const deleted = await db
        .delete(serviceAccounts)
        .where(eq(serviceAccounts.id, serviceAccountId))
        .returning({ id: serviceAccounts.id });
      return deleted.length > 0;
    },
  };
}

/** Whom a holder's grants may name: a person and each of their teams, or a service account. */
function holderSubjects(holder: GrantHolder, teamIds: readonly string[]): readonly Subject[] {
  if (holder.kind === "service-account") {
    return [{ kind: "service-account", serviceAccountId: holder.serviceAccountId }];
  }
  return [
    { kind: "user", userId: holder.userId },
    ...teamIds.map((teamId) => ({ kind: "team" as const, teamId })),
  ];
}

function serviceAccountView(row: typeof serviceAccounts.$inferSelect): StoredServiceAccount {
  return {
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.createdBy, name: row.createdByName },
    id: row.id,
    name: row.name,
    projectId: row.projectId,
  };
}

function validServiceAccountName(name: string): string {
  const valid = validName("service account", name);
  // A service account is named by id or name, so a name shaped like an id would be ambiguous.
  if (isUuid(valid)) {
    throw new CodedError(
      "SERVICE_ACCOUNT_NAME_INVALID",
      "A service account name must not be shaped like an id.",
    );
  }
  return valid;
}

function serviceAccountConflict(name: string): CodedError {
  return new CodedError(
    "SERVICE_ACCOUNT_NAME_CONFLICT",
    `The project has a service account named "${name}".`,
  );
}

function viaTeam(
  known: readonly { readonly teamId: string; readonly teamName: string }[],
): (teamId: string | null) => GrantVia {
  const names = new Map(known.map((team) => [team.teamId, team.teamName]));
  return (teamId) => (teamId === null ? null : { teamId, teamName: names.get(teamId) ?? "" });
}

function projectView(row: typeof projects.$inferSelect): StoredProject {
  return { createdAt: row.createdAt.toISOString(), id: row.id, name: row.name, slug: row.slug };
}

function teamView(
  row: { readonly createdAt: Date; readonly id: string; readonly name: string },
  memberIds: readonly string[],
): StoredTeam {
  return { createdAt: row.createdAt.toISOString(), id: row.id, memberIds, name: row.name };
}

function validProject(input: { readonly slug: string; readonly name: string }) {
  const slug = input.slug.trim();
  // A project is named by id or slug, so a slug shaped like an id would be ambiguous.
  if (!PROJECT_SLUG.test(slug) || isUuid(slug)) {
    throw new CodedError(
      "PROJECT_SLUG_INVALID",
      "A project slug is 1-64 lowercase letters, digits and hyphens, starting with a letter or digit, and not shaped like an id.",
    );
  }
  return { name: validName("project", input.name), slug };
}

const NAME_INVALID = {
  project: "PROJECT_NAME_INVALID",
  "service account": "SERVICE_ACCOUNT_NAME_INVALID",
  team: "TEAM_NAME_INVALID",
} as const;

function validName(kind: keyof typeof NAME_MAX, name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX[kind]) {
    throw new CodedError(NAME_INVALID[kind], `A ${kind} name is 1-${NAME_MAX[kind]} characters.`);
  }
  return trimmed;
}

function slugConflict(slug: string): CodedError {
  return new CodedError("PROJECT_SLUG_CONFLICT", `A project with slug "${slug}" exists.`);
}

function teamConflict(name: string): CodedError {
  return new CodedError("TEAM_NAME_CONFLICT", `A team named "${name}" exists.`);
}

function environmentNotProtected(environment: string): CodedError {
  return new CodedError(
    "ENVIRONMENT_NOT_PROTECTED",
    `Environment ${environment} is not protected in this project; protect it before granting it.`,
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function grantOfRow(row: typeof accessGrants.$inferSelect, via: GrantVia): Grant {
  const { projectId, role } = row;
  if (row.on === "project") return { on: "project", projectId, role, via };
  if (role === "admin") throw new Error("Only a project grant may carry admin.");
  if (row.on === "automation" && row.automationId !== null)
    return { on: "automation", automationId: row.automationId, projectId, role, via };
  if (row.on === "environment" && row.environment !== null)
    return { on: "environment", environment: row.environment, projectId, role, via };
  throw new Error("Invalid grant target in the database.");
}
