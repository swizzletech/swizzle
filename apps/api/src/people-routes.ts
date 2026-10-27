/**
 * The people of an instance over HTTP (ADR 0014). Owners and admins invite, change, suspend and
 * remove people. The auth store decides who may change whom (`mayManagePeople` in
 * packages/db/src/access.ts) in the transaction that makes the change, and keeps the last active
 * owner; these routes pass it the actor. `POST /invitations` answers with the invitation's link
 * once, for the inviter to pass on, and also mails it when SWIZZLE_SMTP_URL is set. The recipient
 * reads it with `POST /auth/invitation` and accepts it through `/auth/sign-up/email`.
 *
 * | Route                               | Access    | Does                                        |
 * |-------------------------------------|-----------|---------------------------------------------|
 * | GET /users                          | instance  | everyone, with role and suspension           |
 * | GET /directory                      | resource  | minimal identities in visible projects       |
 * | PUT /users/:userId/role             | instance  | changes the instance role                    |
 * | PUT /users/:userId/suspension       | instance  | suspends: sessions end, tokens are refused   |
 * | DELETE /users/:userId/suspension    | instance  | reactivates                                  |
 * | DELETE /users/:userId/two-factor    | instance  | turns off a lost second factor               |
 * | POST /users/:userId/reset-link      | instance  | a one-time password reset link, shown once   |
 * | DELETE /users/:userId               | instance  | offboards: deletes the account               |
 * | GET /invitations                    | instance  | pending invitations                          |
 * | POST /invitations                   | instance  | invites with project grants; link shown once |
 * | DELETE /invitations/:invitationId   | instance  | revokes one                                  |
 * | POST /auth/invitation               | public    | what a token's invitation offers             |
 */
import {
  type AccessStore,
  type AuthUser,
  CodedError,
  INSTANCE_ROLES,
  type InstanceRole,
  PROJECT_ROLES,
  type ProjectRole,
} from "@swizzle/db";
import type { Invitation, SwizzleAuth } from "@swizzle/db/postgres";
import { AutomationRuntimeError } from "@swizzle/runtime";
import type {
  DirectoryResponse,
  InvitationOfferResponse,
  InvitationsResponse,
  NoContentResponse,
  PeopleResponse,
  PersonResponse,
  ResetLinkResponse,
  SentInvitationResponse,
} from "@swizzle/runtime/http-contract";
import type { FastifyRequest } from "fastify";

import { type ApiServer, getEnvironment } from "./http-shared.js";
import { environmentName, nonEmptyText, objectSchema } from "./request-validation.js";

export interface RegisterPeopleRoutesOptions {
  readonly accessStore: AccessStore;
  readonly auth: SwizzleAuth;
}

const roleField = { enum: [...INSTANCE_ROLES], type: "string" } as const;

export function registerPeopleRoutes(app: ApiServer, options: RegisterPeopleRoutesOptions): void {
  const { accessStore, auth } = options;

  /** Each grant with its project's name; a project deleted since drops out. */
  const withProjects = async (invitation: Invitation) => {
    const grants = await Promise.all(
      invitation.grants.map(async (grant) => {
        const project = await accessStore.getProject(grant.projectId);
        return project === null
          ? []
          : [
              {
                project: { id: project.id, name: project.name, slug: project.slug },
                role: grant.role,
              },
            ];
      }),
    );
    return { ...invitation, grants: grants.flat() };
  };

  app.get<{ Reply: DirectoryResponse }>(
    "/directory",
    {
      schema: { querystring: objectSchema({ environment: environmentName }) },
    },
    async (request) => {
      const scope = await request.access.scope(getEnvironment(request));
      return accessStore.directory(
        scope.all
          ? "all"
          : [
              ...new Set([
                ...scope.projectIds,
                ...scope.automations.map(({ projectId }) => projectId),
              ]),
            ],
      );
    },
  );

  app.get<{ Reply: PeopleResponse }>("/users", async () => ({
    users: (await auth.listPeople()).map(
      ({ email, id, name, role, suspended, twoFactorEnabled }) => ({
        email,
        id,
        name,
        role,
        suspended,
        twoFactorEnabled,
      }),
    ),
  }));

  app.put<{ Reply: PersonResponse }>(
    "/users/:userId/role",
    { schema: { body: objectSchema({ role: roleField }, ["role"]) } },
    async (request) => {
      const { role } = request.body as { role: InstanceRole };
      return await updated(auth.setRole(actingPerson(request), userIdOf(request), role));
    },
  );

  app.put<{ Reply: PersonResponse }>("/users/:userId/suspension", async (request) => {
    return await updated(auth.setSuspended(actingPerson(request), userIdOf(request), true));
  });

  app.delete<{ Reply: PersonResponse }>("/users/:userId/suspension", async (request) => {
    return await updated(auth.setSuspended(actingPerson(request), userIdOf(request), false));
  });

  app.delete<{ Reply: NoContentResponse }>("/users/:userId/two-factor", async (request, reply) => {
    const person = await auth.findPerson(userIdOf(request));
    if (person === null) throw new CodedError("USER_NOT_FOUND", "No such person.");
    if (!(await auth.resetTwoFactor(actingPerson(request), person.id))) {
      throw new CodedError("TWO_FACTOR_NOT_FOUND", `${person.email} has no two-factor sign-in.`);
    }
    return reply.status(204).send();
  });

  app.post<{ Reply: ResetLinkResponse }>("/users/:userId/reset-link", async (request, reply) => {
    const link = await auth.createResetLink(actingPerson(request), userIdOf(request));
    if (link === null) throw new CodedError("USER_NOT_FOUND", "No such person.");
    reply.status(201);
    return link;
  });

  app.delete<{ Reply: NoContentResponse }>("/users/:userId", async (request, reply) => {
    if (!(await auth.removePerson(actingPerson(request), userIdOf(request)))) {
      throw new CodedError("USER_NOT_FOUND", "No such person.");
    }
    return reply.status(204).send();
  });

  app.get<{ Reply: InvitationsResponse }>("/invitations", async () => ({
    invitations: await Promise.all((await auth.listInvitations()).map(withProjects)),
  }));

  const invitationBody = {
    schema: {
      body: objectSchema(
        {
          email: { format: "email", maxLength: 320, type: "string" },
          projects: {
            items: objectSchema(
              { project: nonEmptyText, role: { enum: [...PROJECT_ROLES], type: "string" } },
              ["project", "role"],
            ),
            maxItems: 50,
            type: "array",
          },
          role: roleField,
        },
        ["email", "role"],
      ),
    },
  };
  app.post<{ Reply: SentInvitationResponse }>(
    "/invitations",
    invitationBody,
    async (request, reply) => {
      const body = request.body as {
        email: string;
        role: InstanceRole;
        projects?: { project: string; role: ProjectRole }[];
      };
      const actor = request.actor;
      if (actor?.kind !== "person") {
        throw new AutomationRuntimeError(
          "ACCESS_DENIED",
          "An invitation names the person who sent it. Sign in to send one.",
        );
      }
      const grants = [];
      for (const { project: reference, role } of body.projects ?? []) {
        const project = await accessStore.getProject(reference);
        if (project === null) {
          throw new AutomationRuntimeError("PROJECT_NOT_FOUND", `Project not found: ${reference}`);
        }
        grants.push({ projectId: project.id, role });
      }
      const sent = await auth.invite({
        email: body.email,
        grants,
        invitedBy: actor.userId,
        role: body.role,
      });
      reply.status(201);
      return {
        ...(await withProjects(sent.invitation)),
        mailed: sent.mailed,
        url: sent.url,
      };
    },
  );

  app.delete<{ Reply: NoContentResponse }>("/invitations/:invitationId", async (request, reply) => {
    const { invitationId } = request.params as { invitationId: string };
    if (!(await auth.revokeInvitation(actingPerson(request), invitationId))) {
      throw new CodedError("INVITATION_NOT_FOUND", "No pending invitation has this id.");
    }
    return reply.status(204).send();
  });

  app.post<{ Reply: InvitationOfferResponse }>(
    "/auth/invitation",
    { schema: { body: objectSchema({ token: nonEmptyText }, ["token"]) } },
    async (request) => {
      const invitation = await auth.findInvitation((request.body as { token: string }).token);
      if (invitation === null) {
        throw new CodedError(
          "AUTH_INVITATION_INVALID",
          "This invitation is used, revoked or expired. Ask for a new one.",
        );
      }
      const inviter =
        invitation.invitedBy === null ? null : await auth.findPerson(invitation.invitedBy);
      const { email, expiresAt, grants, role } = await withProjects(invitation);
      return { email, expiresAt, invitedBy: inviter?.name ?? null, projects: grants, role };
    },
  );
}

/** The person who asks; a service account never manages people. */
function actingPerson(request: FastifyRequest): string {
  const actor = request.actor;
  if (actor?.kind === "person") return actor.userId;
  throw new AutomationRuntimeError("ACCESS_DENIED", "Only owners and admins manage people.");
}

function userIdOf(request: FastifyRequest): string {
  return (request.params as { userId: string }).userId;
}

async function updated(change: Promise<AuthUser | null>): Promise<AuthUser> {
  const person = await change;
  if (person === null) throw new CodedError("USER_NOT_FOUND", "No such person.");
  return person;
}
