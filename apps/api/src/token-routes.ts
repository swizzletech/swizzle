import type { DeleteServiceAccountResult } from "@swizzle/db";
/**
 * API tokens and service accounts over HTTP (ADR 0014), and who a request acts as.
 *
 * - A person mints, lists and revokes their own tokens. A token's scope is fixed when it is
 *   minted: a highest role and optionally its projects and environments (access.ts, TokenScope).
 *   Without a scope it acts with all of its person's rights.
 * - A project's admins list, create and delete its service accounts, signed in or with a token
 *   whose scope reaches admin there, and mint, rotate and revoke their tokens. The account's
 *   rights are grants on the project (access-routes.ts, `serviceAccount`), at most editor; a token
 *   can narrow them further.
 * - Every mint, rotation and revocation needs a browser session, so no token mints a token.
 * - `GET /auth/identity` tells any caller who it acts as, with which token scope, and its role in
 *   a project and environment it names. The CLI's `swizzle whoami` shows it.
 */
import {
  type AccessStore,
  accountView,
  CodedError,
  type CreateServiceAccountResult,
  FULL_SCOPE,
  type PersonOnRecord,
  projectRef,
  SERVICE_ACCOUNT_MAX_ROLE,
  type ShareRole,
  type StoredServiceAccount,
  type TokenDirectory,
  type TokenScope,
  tokenView,
  tokenViews,
} from "@swizzle/db";
import type { ApiTokenStore, StoredApiToken, SwizzleAuth, TokenHolder } from "@swizzle/db/postgres";
import { AutomationRuntimeError } from "@swizzle/runtime";
import type {
  CreatedTokenResponse,
  CreateServiceAccountResponse,
  DeleteServiceAccountResponse,
  IdentityResponse,
  ServiceAccountsResponse,
  TokenResponse,
  TokensResponse,
} from "@swizzle/runtime/http-contract";
import type { FastifyRequest } from "fastify";
import { browserSession } from "./auth-routes.js";
import type { ApiServer } from "./http-shared.js";
import {
  environmentName,
  nonEmptyText,
  objectSchema,
  text,
  urlText,
} from "./request-validation.js";

export interface RegisterTokenRoutesOptions {
  readonly accessStore: AccessStore;
  readonly apiTokenStore: ApiTokenStore;
  readonly auth: SwizzleAuth;
}

/** A scope as a request names it: projects by slug or id; a missing field limits nothing. */
interface ScopeBody {
  readonly role?: TokenScope["role"];
  readonly projects?: readonly string[];
  readonly environments?: readonly string[];
}

interface TokenBody {
  readonly name: string;
  readonly expiresAt?: string;
  readonly scope?: ScopeBody;
}

const scopeSchema = (roles: readonly string[], projects: boolean) =>
  objectSchema({
    environments: { items: environmentName, maxItems: 50, minItems: 1, type: "array" },
    ...(projects ? { projects: { items: urlText, maxItems: 50, minItems: 1, type: "array" } } : {}),
    role: { enum: roles, type: "string" },
  });

const tokenBody = (roles: readonly string[], projects: boolean) => ({
  schema: {
    body: objectSchema(
      { expiresAt: text, name: nonEmptyText, scope: scopeSchema(roles, projects) },
      ["name"],
    ),
  },
});

const SHARE_ROLES: readonly ShareRole[] = ["viewer", "operator", "editor"];

export function registerTokenRoutes(app: ApiServer, options: RegisterTokenRoutesOptions): void {
  const { accessStore, apiTokenStore: tokens, auth } = options;

  app.get<{ Reply: IdentityResponse }>(
    "/auth/identity",
    {
      schema: {
        querystring: objectSchema({ environment: environmentName, project: urlText }),
      },
    },
    async (request) => {
      const query = request.query as { project?: string; environment?: string };
      const actor = request.actor;
      const target =
        query.project === undefined
          ? null
          : await targetRole(request, accessStore, query.project, query.environment);
      // The auth guard admits only people and service accounts to this route.
      if (actor === undefined || actor.kind === "worker") throw new Error("No signed-in actor.");
      const token =
        actor.token === null
          ? null
          : await tokenView(directory(options), await currentToken(tokens, actor, actor.token.id));
      if (actor.kind === "person") {
        const person = await auth.findPerson(actor.userId);
        return {
          kind: "person",
          person:
            person === null
              ? null
              : { email: person.email, id: person.id, name: person.name, role: person.role },
          serviceAccount: null,
          target,
          token,
        };
      }
      const [account, project] = await Promise.all([
        accessStore.getServiceAccount(actor.projectId, actor.serviceAccountId),
        accessStore.getProject(actor.projectId),
      ]);
      return {
        kind: "service-account",
        person: null,
        serviceAccount:
          account === null || project === null
            ? null
            : { id: account.id, name: account.name, project: projectRef(project) },
        target,
        token,
      };
    },
  );

  app.post<{ Reply: CreatedTokenResponse }>(
    "/auth/tokens",
    tokenBody(["viewer", "operator", "editor", "admin"], true),
    async (request, reply) => {
      const person = browserSession(request).user;
      const body = request.body as TokenBody;
      const created = await tokens.createToken({
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        holder: { kind: "person", userId: person.id },
        issuedBy: person,
        name: body.name,
        scope: await personalScope(request, accessStore, body.scope),
      });
      reply.status(201);
      return { ...(await tokenView(directory(options), created)), token: created.token };
    },
  );

  app.get<{ Reply: TokensResponse }>("/auth/tokens", async (request) => {
    const holder: TokenHolder = { kind: "person", userId: browserSession(request).user.id };
    return { tokens: await tokenViews(directory(options), await tokens.listTokens(holder)) };
  });

  app.delete<{ Reply: TokenResponse }>("/auth/tokens/:identifier", async (request) => {
    const holder: TokenHolder = { kind: "person", userId: browserSession(request).user.id };
    const { identifier } = request.params as { identifier: string };
    const revoked = await tokens.revokeToken(holder, identifier);
    if (revoked === null) throw tokenNotFound(identifier);
    return await tokenView(directory(options), revoked);
  });

  /** The project once the caller administers it, by session or by a token that reaches admin. */
  const administered = async (request: FastifyRequest) => {
    const { project: reference } = request.params as { project: string };
    return await request.access.project(reference, { action: "administer" });
  };
  const accountOf = async (request: FastifyRequest) => {
    const project = await administered(request);
    const { account: reference } = request.params as { account: string };
    const account = await accessStore.getServiceAccount(project.id, reference);
    if (account === null) {
      throw new CodedError(
        "SERVICE_ACCOUNT_NOT_FOUND",
        `Project ${project.slug} has no service account ${reference}.`,
      );
    }
    const holder: TokenHolder = { kind: "service-account", serviceAccountId: account.id };
    return { account, holder, project };
  };
  /**
   * An account's token for the session's person. The right comes first, so a caller who cannot see
   * the project learns nothing of it; a token learns that only a session mints.
   */
  const accountForSession = async (request: FastifyRequest) => {
    const found = await accountOf(request);
    return { ...found, person: sessionPerson(request) };
  };

  app.get<{ Reply: ServiceAccountsResponse }>(
    "/projects/:project/service-accounts",
    async (request) => {
      const project = await administered(request);
      const [accounts, access] = await Promise.all([
        accessStore.listServiceAccounts(project.id),
        accessStore.projectAccess(project.id),
      ]);
      const names = directory(options);
      return {
        serviceAccounts: await Promise.all(
          accounts.map((account) => accountView(names, tokens, account, access)),
        ),
      };
    },
  );

  app.post<{ Reply: CreateServiceAccountResponse }>(
    "/projects/:project/service-accounts",
    { schema: { body: objectSchema({ name: nonEmptyText }, ["name"]) } },
    async (request, reply) => {
      const project = await administered(request);
      const actor = request.actor;
      // A personal token's person, or the session's.
      const creator =
        actor?.kind === "person" && actor.token !== null
          ? await auth.findPerson(actor.userId)
          : null;
      const { name } = request.body as { name: string };
      let account: StoredServiceAccount;
      let changed = true;
      try {
        account = await accessStore.createServiceAccount({
          createdBy:
            creator === null ? sessionPerson(request) : { id: creator.id, name: creator.name },
          name,
          projectId: project.id,
        });
      } catch (error) {
        if (!(error instanceof CodedError) || error.code !== "SERVICE_ACCOUNT_NAME_CONFLICT")
          throw error;
        const existing = await accessStore.getServiceAccount(project.id, name);
        if (existing === null) throw error;
        account = existing;
        changed = false;
      }
      reply.status(changed ? 201 : 200);
      return {
        ...(await accountView(
          directory(options),
          tokens,
          account,
          await accessStore.projectAccess(project.id),
        )),
        changed,
      } satisfies CreateServiceAccountResult;
    },
  );

  app.delete<{ Reply: DeleteServiceAccountResponse }>(
    "/projects/:project/service-accounts/:account",
    async (request) => {
      const project = await administered(request);
      const { account: reference } = request.params as { account: string };
      const account = await accessStore.getServiceAccount(project.id, reference);
      const changed = account !== null && (await accessStore.deleteServiceAccount(account.id));
      return {
        serviceAccount: account?.name ?? reference,
        changed,
      } satisfies DeleteServiceAccountResult;
    },
  );

  app.post<{ Reply: CreatedTokenResponse }>(
    "/projects/:project/service-accounts/:account/tokens",
    tokenBody(SHARE_ROLES, false),
    async (request, reply) => {
      const { holder, person } = await accountForSession(request);
      const body = request.body as TokenBody;
      const created = await tokens.createToken({
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        holder,
        issuedBy: person,
        name: body.name,
        scope: {
          environments: body.scope?.environments ?? null,
          projectIds: null,
          role: body.scope?.role ?? SERVICE_ACCOUNT_MAX_ROLE,
        },
      });
      reply.status(201);
      return { ...(await tokenView(directory(options), created)), token: created.token };
    },
  );

  app.post<{ Reply: CreatedTokenResponse }>(
    "/projects/:project/service-accounts/:account/tokens/:identifier/rotation",
    async (request, reply) => {
      const { holder, person } = await accountForSession(request);
      const { identifier } = request.params as { identifier: string };
      const rotated = await tokens.rotateToken(holder, identifier, person);
      if (rotated === null) throw tokenNotFound(identifier);
      reply.status(201);
      return { ...(await tokenView(directory(options), rotated)), token: rotated.token };
    },
  );

  app.delete<{ Reply: TokenResponse }>(
    "/projects/:project/service-accounts/:account/tokens/:identifier",
    async (request, reply) => {
      const { holder } = await accountForSession(request);
      const { identifier } = request.params as { identifier: string };
      const revoked = await tokens.revokeToken(holder, identifier);
      if (revoked === null) throw tokenNotFound(identifier);
      return reply.send(await tokenView(directory(options), revoked));
    },
  );
}

/** The person of the browser session; minting, rotating and revoking tokens needs one. */
function sessionPerson(request: FastifyRequest): PersonOnRecord {
  const person = request.signedInPerson;
  if (person === undefined) {
    throw new CodedError(
      "AUTH_SESSION_REQUIRED",
      "This security-sensitive action requires a signed-in browser session.",
    );
  }
  return { id: person.user.id, name: person.user.name };
}

/** A personal scope with its projects resolved to ids; a project the person cannot see is a 404. */
async function personalScope(
  request: FastifyRequest,
  accessStore: AccessStore,
  body: ScopeBody | undefined,
): Promise<TokenScope> {
  if (body === undefined) return FULL_SCOPE;
  const projectIds =
    body.projects === undefined
      ? null
      : await Promise.all(
          body.projects.map(async (reference) => {
            const project = await accessStore.getProject(reference);
            if (project === null || (await request.access.role(project.id)) === null) {
              throw new AutomationRuntimeError(
                "PROJECT_NOT_FOUND",
                `Project not found: ${reference}`,
              );
            }
            return project.id;
          }),
        );
  return {
    environments: body.environments ?? null,
    projectIds,
    role: body.role ?? FULL_SCOPE.role,
  };
}

/** The caller's role in a project and environment; null when it cannot see the project. */
async function targetRole(
  request: FastifyRequest,
  accessStore: AccessStore,
  reference: string,
  environment: string | undefined,
) {
  const project = await accessStore.getProject(reference);
  const outOfReach = { environment: environment ?? null, project: { reference }, role: null };
  if (project === null) return outOfReach;
  const role =
    environment === undefined
      ? await request.access.role(project.id)
      : await request.access.roleIn(project.id, environment);
  if (role === null) return outOfReach;
  return { environment: environment ?? null, project: { reference, ...projectRef(project) }, role };
}

/** The token row of the request, read again so the answer shows its last use and expiry. */
async function currentToken(
  store: ApiTokenStore,
  actor:
    | { readonly kind: "person"; readonly userId: string }
    | { readonly kind: "service-account"; readonly serviceAccountId: string },
  tokenId: string,
): Promise<StoredApiToken> {
  const holder: TokenHolder =
    actor.kind === "person"
      ? { kind: "person", userId: actor.userId }
      : { kind: "service-account", serviceAccountId: actor.serviceAccountId };
  const token = (await store.listTokens(holder)).find((candidate) => candidate.id === tokenId);
  if (token === undefined) throw tokenNotFound(tokenId);
  return token;
}

/**
 * The projects and people token views name, each read once per request when first asked for, so
 * a list of accounts reads only what its tokens reference.
 */

function directory({ accessStore }: RegisterTokenRoutesOptions): TokenDirectory {
  const projects = new Map<string, ReturnType<TokenDirectory["project"]>>();
  return { project: (id) => once(projects, id, () => accessStore.getProject(id)) };
}

function once<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = read();
  cache.set(key, value);
  return value;
}

function tokenNotFound(identifier: string): Error {
  return new CodedError("API_TOKEN_NOT_FOUND", `API token not found: ${identifier}`);
}
