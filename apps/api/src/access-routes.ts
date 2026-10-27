import type { CreateProjectResult, CreateTeamResult, DeleteTeamResult } from "@swizzle/db";
import { CodedError } from "@swizzle/db";
import type {
  CreateProjectResponse,
  CreateTeamResponse,
  DeleteProjectResponse,
  DeleteTeamResponse,
  EnvironmentProtectionResponse,
  ProjectAccessResponse,
  ProjectContentsResponse,
  ProjectsResponse,
  RemoveGrantResponse,
  SetGrantResponse,
  TeamMembershipResponse,
  TeamsResponse,
} from "@swizzle/runtime/http-contract";
/**
 * Projects, teams and grants over HTTP (ADR 0014). Instance owners and admins create projects and
 * teams; a project's admins grant roles in it, protect its environments and share its automations.
 * What a grant allows is decided in packages/db/src/access.ts, never here.
 */

import { createDisplayName } from "@swizzle/core";
import {
  type AccessStore,
  type GrantPlace,
  type GrantQuery,
  type GrantRemovalResult,
  type GrantTarget,
  type GrantWriteResult,
  loadHolderDirectory,
  type MembershipResult,
  PROJECT_ROLES,
  type ProjectContents,
  type ProjectRole,
  type ProtectionResult,
  projectAccessView,
  SERVICE_ACCOUNT_MAX_ROLE,
  type SetGrantBody,
  type StoredProject,
  type Subject,
} from "@swizzle/db";
import type { EnvironmentStore, SwizzleAuth } from "@swizzle/db/postgres";
import { AutomationRuntimeError } from "@swizzle/runtime";
import type { PlatformServices } from "@swizzle/runtime/platform";
import type { FastifyRequest } from "fastify";

import { type ApiServer, requestValidationError } from "./http-shared.js";
import {
  environmentName,
  nonEmptyText,
  objectSchema,
  queryBoolean,
  urlText,
} from "./request-validation.js";

export interface RegisterAccessRoutesOptions {
  readonly accessStore: AccessStore;
  readonly auth: SwizzleAuth;
  /** Lists the environments a project's holders get a role in. */
  readonly environmentStore: Pick<EnvironmentStore, "listEnvironments">;
  readonly platform: PlatformServices;
}

/**
 * Who a grant names and where it applies: `user` by id or email, `team` by id or name, or
 * `serviceAccount` by id or name among the project's own service accounts.
 */
export type SubjectQuery = Pick<GrantQuery, "serviceAccount" | "team" | "user">;

export const subjectFields = { serviceAccount: urlText, team: urlText, user: urlText };

const grantFields = {
  ...subjectFields,
  automation: urlText,
  environment: environmentName,
};

export function registerAccessRoutes(app: ApiServer, options: RegisterAccessRoutesOptions): void {
  const { accessStore, auth, environmentStore, platform } = options;

  const subjectOf = (query: GrantQuery, project: StoredProject) =>
    subjectNamed({ accessStore, auth }, query, project.id);

  const placeOf = async (project: StoredProject, query: GrantQuery): Promise<GrantPlace> => {
    if (query.environment !== undefined && query.automation !== undefined) {
      return requestValidationError(
        "A grant applies to an environment or an automation, not both.",
      );
    }
    if (query.environment !== undefined) {
      return { environment: query.environment, on: "environment", projectId: project.id };
    }
    if (query.automation !== undefined) {
      const owner = await platform.findAutomation(query.automation);
      if (owner === null || owner.projectId !== project.id) {
        throw new AutomationRuntimeError(
          "AUTOMATION_NOT_FOUND",
          `Project ${project.slug} has no automation ${query.automation}.`,
        );
      }
      return {
        automationId: owner.automationId,
        automationSlug: owner.automationSlug,
        on: "automation",
        projectId: project.id,
      };
    }
    return { on: "project", projectId: project.id };
  };

  /**
   * The project once the actor administers it. A grant change passes the place it names, so a
   * refused one is audited with that environment or automation, as the request named them.
   */
  const administered = async (request: FastifyRequest, place: GrantQuery = {}) => {
    const { project } = request.params as { project: string };
    return await request.access.project(
      project,
      { action: "administer" },
      {
        ...(place.environment === undefined ? {} : { environment: place.environment }),
        ...(place.automation === undefined
          ? {}
          : { automationSlug: createDisplayName(place.automation) }),
      },
    );
  };

  // Everyone who sees a project sees where it is protected, so a refused change there explains itself.
  app.get<{ Reply: ProjectsResponse }>("/projects", async (request) => {
    const projects = await accessStore.listProjects();
    const seen = await Promise.all(
      projects.map(async (project) => {
        const role = await request.access.role(project.id);
        return role === null ? null : { ...project, role };
      }),
    );
    return { projects: seen.filter((project) => project !== null) };
  });

  const projectBody = {
    schema: { body: objectSchema({ name: nonEmptyText, slug: nonEmptyText }, ["name", "slug"]) },
  };
  app.post<{ Reply: CreateProjectResponse }>("/projects", projectBody, async (request, reply) => {
    const body = request.body as { name: string; slug: string };
    try {
      const project = await accessStore.createProject(body);
      reply.status(201);
      return { ...project, changed: true } satisfies CreateProjectResult;
    } catch (error) {
      if (!(error instanceof CodedError) || error.code !== "PROJECT_SLUG_CONFLICT") throw error;
      const project = await accessStore.getProject(body.slug);
      if (project === null) throw error;
      return { ...project, changed: false } satisfies CreateProjectResult;
    }
  });

  // What deleting the project must decide about: its automations, credentials and runs.
  app.get<{ Reply: ProjectContentsResponse }>("/projects/:project/contents", async (request) => {
    const project = await administered(request);
    const counts = await platform.countProjectContents(project.id);
    if (counts === null) {
      throw new AutomationRuntimeError("PROJECT_NOT_FOUND", `Project not found: ${project.slug}`);
    }
    return counts;
  });

  // ADR 0015: `contents=move&to=<project>` moves the automations, credentials and runs to a
  // project the caller also administers; `contents=delete` deletes them. Without `contents` only
  // an empty project goes. Audit events stay either way.
  const deleteProjectQuery = {
    schema: {
      querystring: objectSchema({
        confirm: queryBoolean,
        contents: { enum: ["delete", "move"], type: "string" },
        to: urlText,
      }),
    },
  };
  app.delete<{ Reply: DeleteProjectResponse }>(
    "/projects/:project",
    deleteProjectQuery,
    async (request) => {
      const project = await administered(request);
      const query = request.query as {
        readonly confirm?: string;
        readonly contents?: "delete" | "move";
        readonly to?: string;
      };
      let contents: ProjectContents | null = null;
      if (query.contents === "move") {
        if (query.to === undefined) {
          return requestValidationError("contents=move needs to=<project>.");
        }
        let target: StoredProject;
        try {
          target = await request.access.project(query.to, { action: "administer" });
        } catch (error) {
          if (error instanceof AutomationRuntimeError && error.code === "PROJECT_NOT_FOUND")
            throw new CodedError(
              "PROJECT_MOVE_TARGET_NOT_FOUND",
              `Move destination not found: ${query.to}`,
            );
          throw error;
        }
        contents = { kind: "move", projectId: target.id };
      } else if (query.contents === "delete") {
        if (query.to !== undefined) return requestValidationError("to= goes with contents=move.");
        contents = { kind: "delete" };
      } else if (query.to !== undefined) {
        return requestValidationError("to= goes with contents=move.");
      }
      if (query.confirm === "false") {
        const counts = await platform.countProjectContents(project.id);
        if (
          counts !== null &&
          contents === null &&
          Object.values(counts).some((count) => count > 0)
        ) {
          throw new CodedError(
            "PROJECT_NOT_EMPTY",
            "Choose whether the project's contents move or go with it.",
            { details: { ...counts, project: project.slug } },
          );
        }
        throw new CodedError(
          "CONFIRMATION_REQUIRED",
          `This deletes project ${project.slug} with its grants, protections and service accounts. Its contents ${contents?.kind === "move" ? `move to ${query.to}` : "are deleted"}. Audit events stay.`,
          { details: { project: project.slug, contents: contents?.kind ?? "empty", to: query.to } },
        );
      }
      await request.audit.note({
        contents: contents?.kind ?? null,
        ...(contents?.kind === "move" ? { to: contents.projectId } : {}),
      });
      try {
        const result = await platform.deleteProject({ contents, projectId: project.id });
        return { ...result, project: project.slug, changed: true };
      } catch (error) {
        if (error instanceof CodedError && error.code === "PROJECT_NOT_FOUND")
          return { project: project.slug, changed: false };
        if (error instanceof CodedError && error.code === "PROJECT_NOT_EMPTY")
          throw new CodedError(error.code, error.message, {
            details: { ...error.details, project: project.slug },
          });
        throw error;
      }
    },
  );

  app.get<{ Reply: ProjectAccessResponse }>("/projects/:project/access", async (request) => {
    const project = await administered(request);
    const directory = await loadHolderDirectory({ accessStore, people: auth }, project.id);
    if (directory === null) {
      throw new AutomationRuntimeError("PROJECT_NOT_FOUND", `Project not found: ${project.slug}`);
    }
    const { access } = directory;
    const environments = [
      ...new Set<string>([
        request.server.configuredEnvironment,
        ...(await environmentStore.listEnvironments()).map((environment) => environment.name),
        ...access.protectedEnvironments,
        ...access.grants.flatMap((grant) =>
          grant.on === "environment" ? [grant.environment] : [],
        ),
      ]),
    ];
    return projectAccessView(directory, environments);
  });

  const grantBody = {
    schema: {
      body: objectSchema({ ...grantFields, role: { enum: [...PROJECT_ROLES], type: "string" } }, [
        "role",
      ]),
    },
  };
  app.put<{ Reply: SetGrantResponse }>("/projects/:project/grants", grantBody, async (request) => {
    const body = request.body as SetGrantBody;
    const project = await administered(request, body);
    const place = await placeOf(project, body);
    const { subject, label } = await subjectOf(body, project);
    const { role } = body;
    let target: GrantTarget;
    if (role === "admin" && subject.kind === "service-account") {
      return requestValidationError(
        `A service account holds at most ${SERVICE_ACCOUNT_MAX_ROLE}; it never administers a project.`,
      );
    } else if (place.on === "project") {
      target = { ...place, role };
    } else if (role === "admin") {
      return requestValidationError("Only a project grant can give admin.");
    } else {
      target = { ...place, role };
    }
    let previousRole: ProjectRole | null;
    try {
      previousRole = await accessStore.setGrant(subject, target);
    } catch (error) {
      if (!(error instanceof CodedError) || error.code !== "ENVIRONMENT_NOT_PROTECTED") throw error;
      throw new CodedError(error.code, error.message, {
        details: {
          project: project.slug,
          environment: place.on === "environment" ? place.environment : null,
        },
      });
    }
    return { project: project.slug, subject: label, role, previousRole } satisfies GrantWriteResult;
  });

  const grantQuery = { schema: { querystring: objectSchema(grantFields) } };
  app.delete<{ Reply: RemoveGrantResponse }>(
    "/projects/:project/grants",
    grantQuery,
    async (request) => {
      const query = request.query as GrantQuery;
      const project = await administered(request, query);
      const { subject, label } = await subjectOf(query, project);
      const changed = await accessStore.removeGrant(subject, await placeOf(project, query));
      return { project: project.slug, subject: label, changed } satisfies GrantRemovalResult;
    },
  );

  const protection = async (request: FastifyRequest, protect: boolean) => {
    const project = await administered(request);
    const { environment } = request.params as { environment: string };
    try {
      const confirmed = (request.query as { confirm?: string }).confirm !== "false";
      const outcome = await accessStore.setEnvironmentProtected(
        project.id,
        environment,
        protect,
        confirmed ? "confirmed" : "required",
      );
      return { project: project.slug, environment, ...outcome } satisfies ProtectionResult;
    } catch (error) {
      if (!(error instanceof CodedError) || error.code !== "CONFIRMATION_REQUIRED") throw error;
      throw new CodedError(error.code, error.message, {
        details: { ...error.details, project: project.slug, environment },
      });
    }
  };
  app.put<{ Reply: EnvironmentProtectionResponse }>(
    "/projects/:project/environments/:environment/protection",
    (request) => protection(request, true),
  );
  app.delete<{ Reply: EnvironmentProtectionResponse }>(
    "/projects/:project/environments/:environment/protection",
    { schema: { querystring: objectSchema({ confirm: queryBoolean }) } },
    (request) => protection(request, false),
  );

  app.get<{ Reply: TeamsResponse }>("/teams", async () => ({
    teams: await accessStore.listTeams(),
  }));

  app.post<{ Reply: CreateTeamResponse }>(
    "/teams",
    { schema: { body: objectSchema({ name: nonEmptyText }, ["name"]) } },
    async (request, reply) => {
      const { name } = request.body as { name: string };
      try {
        const team = await accessStore.createTeam(name);
        reply.status(201);
        return { ...team, changed: true } satisfies CreateTeamResult;
      } catch (error) {
        if (!(error instanceof CodedError) || error.code !== "TEAM_NAME_CONFLICT") throw error;
        const team = (await accessStore.listTeams()).find(
          (team) => team.name.toLowerCase() === name.trim().toLowerCase(),
        );
        if (team === undefined) throw error;
        return { ...team, changed: false } satisfies CreateTeamResult;
      }
    },
  );

  app.delete<{ Reply: DeleteTeamResponse }>("/teams/:team", async (request) => {
    const { team: reference } = request.params as { team: string };
    const team = await findTeam(accessStore, reference);
    const changed = team !== null && (await accessStore.deleteTeam(team.id));
    return { team: team?.name ?? reference, changed } satisfies DeleteTeamResult;
  });

  const membership = async (request: FastifyRequest, member: boolean) => {
    const params = request.params as { team: string; person: string };
    const team = await findTeam(accessStore, params.team);
    if (team === null) throw new CodedError("TEAM_NOT_FOUND", "No such team.");
    const person = (await auth.listPeople()).find(
      (person) =>
        person.id === params.person || person.email.toLowerCase() === params.person.toLowerCase(),
    );
    if (person === undefined) throw new CodedError("USER_NOT_FOUND", "No such person.");
    const changed = await accessStore.setTeamMember(team.id, person.id, member);
    return { team: team.name, person: person.email, changed } satisfies MembershipResult;
  };
  app.put<{ Reply: TeamMembershipResponse }>("/teams/:team/members/:person", (request) =>
    membership(request, true),
  );
  app.delete<{ Reply: TeamMembershipResponse }>("/teams/:team/members/:person", (request) =>
    membership(request, false),
  );
}

/**
 * The person (`user` by id or email), team (`team` by id or name) or service account
 * (`serviceAccount` by id or name, in `projectId`) a grant names; 404 for none. A service account
 * of another project is no one here.
 */
export async function subjectNamed(
  stores: { readonly accessStore: AccessStore; readonly auth: Pick<SwizzleAuth, "listPeople"> },
  query: SubjectQuery,
  projectId: string,
): Promise<{ readonly subject: Subject; readonly label: string }> {
  const named = [query.user, query.team, query.serviceAccount].filter((name) => name !== undefined);
  if (named.length !== 1) {
    return requestValidationError("Name exactly one of user, team and serviceAccount.");
  }
  if (query.serviceAccount !== undefined) {
    const account = await stores.accessStore.getServiceAccount(projectId, query.serviceAccount);
    if (account === null) {
      throw new CodedError(
        "SERVICE_ACCOUNT_NOT_FOUND",
        `No such service account in this project: ${query.serviceAccount}`,
      );
    }
    return {
      subject: { kind: "service-account", serviceAccountId: account.id },
      label: account.name,
    };
  }
  if (query.user !== undefined) {
    const reference = query.user;
    const person = (await stores.auth.listPeople()).find(
      (candidate) =>
        candidate.id === reference || candidate.email.toLowerCase() === reference.toLowerCase(),
    );
    if (person === undefined) {
      throw new CodedError("USER_NOT_FOUND", `No such person: ${reference}`);
    }
    return { subject: { kind: "user", userId: person.id }, label: person.email };
  }
  const team = await findTeam(stores.accessStore, query.team as string);
  if (team === null) throw new CodedError("TEAM_NOT_FOUND", `No such team: ${query.team}`);
  return { subject: { kind: "team", teamId: team.id }, label: team.name };
}

async function findTeam(accessStore: AccessStore, reference: string) {
  const teams = await accessStore.listTeams();
  return teams.find((team) => team.id === reference || team.name === reference) ?? null;
}
