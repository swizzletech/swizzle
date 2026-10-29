/**
 * Sign-in over HTTP. `@swizzle/db/postgres` owns the people, their sessions, the guarantees
 * (ADR 0014) and the shape of every forwarded answer (AuthResults); this file forwards the Better
 * Auth routes with their cookies, answers the routes Swizzle adds,
 * and guards every route that is not public in ROUTE_ACCESS with a session cookie or a bearer
 * token, which settles `request.actor` for request-access.ts. Tokens themselves are in
 * token-routes.ts.
 */
import type { AccessStore, WorkerRegistry } from "@swizzle/db";
import { CodedError } from "@swizzle/db";
import {
  type ApiTokenStore,
  type AuthResults,
  type AuthRoute,
  CLIENT_ADDRESS_HEADER,
  INVITATION_TOKEN_HEADER,
  SETUP_TOKEN_HEADER,
  type SignedInPerson,
  type StoredApiToken,
  type SwizzleAuth,
} from "@swizzle/db/postgres";
import type {
  AuthActionResponse,
  AuthStatusResponse,
  NoContentResponse,
  SessionsResponse,
  SignInResponse,
  TwoFactorEnrollmentResponse,
  TwoFactorResponse,
} from "@swizzle/runtime/http-contract";
import type { FastifyReply, FastifyRequest } from "fastify";

import { type ApiServer, getAllowedOrigins } from "./http-shared.js";
import { type Actor, routeAccess } from "./request-access.js";
import { readBooleanSetting } from "./security-config.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** The request headers Better Auth reads; the client address is set from the resolved one. */
const FORWARDED_REQUEST_HEADERS = [
  "cookie",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
  INVITATION_TOKEN_HEADER,
  SETUP_TOKEN_HEADER,
] as const;
const FORWARDED_RESPONSE_HEADERS = ["retry-after"] as const;

declare module "fastify" {
  interface FastifyRequest {
    signedInPerson?: SignedInPerson;
  }
}

export interface RegisterAuthGuardOptions {
  readonly apiTokenStore: ApiTokenStore;
  readonly auth: SwizzleAuth;
  readonly workerRegistry: WorkerRegistry | undefined;
  readonly accessStore: Pick<AccessStore, "findServiceAccount">;
}

export function registerAuthRoutes(app: ApiServer, auth: SwizzleAuth): void {
  // Each Better Auth route is registered by its literal path, so the API reference lists it.
  // The public ones need an allowed page, as the guard asks of every cookie write.
  const forward =
    <Route extends AuthRoute>(route: Route) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<AuthResults[Route]> => {
      if (!isAllowedBrowserOrigin(request)) return respondOriginForbidden();
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      headers.set(CLIENT_ADDRESS_HEADER, request.ip);
      const answer = await auth.handle(route, { body: request.body ?? {}, headers });
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = answer.headers.get(name);
        if (value !== null) reply.header(name, value);
      }
      const cookies = answer.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      if (!answer.ok) throw new CodedError(answer.error, answer.message);
      reply.status(answer.status);
      return answer.result;
    };
  app.post<{ Reply: AuthActionResponse }>("/auth/sign-up/email", forward("/sign-up/email"));
  app.post<{ Reply: SignInResponse }>("/auth/sign-in/email", forward("/sign-in/email"));
  app.post<{ Reply: AuthActionResponse }>("/auth/sign-out", forward("/sign-out"));
  app.post<{ Reply: AuthActionResponse }>(
    "/auth/two-factor/verify-totp",
    forward("/two-factor/verify-totp"),
  );
  app.post<{ Reply: AuthActionResponse }>(
    "/auth/two-factor/verify-backup-code",
    forward("/two-factor/verify-backup-code"),
  );
  app.post<{ Reply: AuthActionResponse }>(
    "/auth/request-password-reset",
    forward("/request-password-reset"),
  );
  app.post<{ Reply: AuthActionResponse }>("/auth/reset-password", forward("/reset-password"));
  app.post<{ Reply: AuthActionResponse }>("/auth/change-password", forward("/change-password"));
  app.post<{ Reply: TwoFactorEnrollmentResponse }>(
    "/auth/two-factor/enable",
    forward("/two-factor/enable"),
  );
  app.post<{ Reply: AuthActionResponse }>(
    "/auth/two-factor/disable",
    forward("/two-factor/disable"),
  );

  app.get<{ Reply: AuthStatusResponse }>("/auth/status", async (request) => {
    const person = await auth.verifySession(requestHeaders(request));
    const setupRequired = await auth.setupRequired();
    return {
      authenticated: person !== null,
      mailConfigured: auth.mailConfigured,
      setupRequired,
      setupTokenRequired: setupRequired && auth.setupTokenRequired,
      user: person?.user ?? null,
    };
  });

  app.get<{ Reply: SessionsResponse }>("/auth/sessions", async (request) => {
    const person = browserSession(request);
    return { sessions: await auth.listSessions(person) };
  });

  app.delete<{ Reply: NoContentResponse }>("/auth/sessions/:sessionId", async (request, reply) => {
    const person = browserSession(request);
    const { sessionId } = request.params as { sessionId: string };
    if (!(await auth.revokeSession(person.user.id, sessionId))) {
      throw new CodedError("AUTH_SESSION_NOT_FOUND", "No signed-in browser has this session id.");
    }
    return reply.status(204).send();
  });

  app.post<{ Reply: NoContentResponse }>("/auth/sessions/revoke-all", async (request, reply) => {
    const person = browserSession(request);
    await auth.revokeAllSessions(person.user.id);
    return reply.status(204).send();
  });

  app.get<{ Reply: TwoFactorResponse }>("/auth/two-factor", async (request) => {
    const person = browserSession(request);
    return await auth.twoFactorStatus(person.user.id);
  });
}

/** Runs before request validation, so an anonymous caller learns nothing about request shapes. */
export function registerAuthGuard(app: ApiServer, options: RegisterAuthGuardOptions): void {
  app.addHook("preValidation", async (request, reply) => {
    if (routeAccess(request) === "public" || isDirectLoopbackReadinessRequest(request)) return;
    const rawApiToken = extractBearerToken(request.headers.authorization);
    const verified =
      rawApiToken === undefined ? null : await options.apiTokenStore.verifyToken(rawApiToken);
    const workerRoute = routeAccess(request) === "worker";
    // Resolve the verified holder, never a token prefix. Workers cannot fall through to cookies.
    if (workerRoute || verified?.holder.kind === "worker") {
      if (verified?.holder.kind !== "worker" || options.workerRegistry === undefined) {
        return reply
          .status(403)
          .send({ code: "WORKER_FORBIDDEN", message: "A live worker token is required." });
      }
      const worker = await options.workerRegistry.authenticate(
        verified.holder.workerId,
        verified.id,
      );
      if (worker.kind === "local")
        return reply.status(403).send({
          code: "WORKER_FORBIDDEN",
          message: "Local worker credentials are accepted only on the private worker listener.",
        });
      if (!workerRoute)
        return reply.status(403).send({
          code: "ACCESS_DENIED",
          message: "Worker tokens authorize only worker protocol requests.",
        });
      request.actor = { kind: "worker", worker };
      return;
    }
    if (rawApiToken !== undefined && verified === null) {
      return respondAuthError({
        code: "FORBIDDEN",
        message: "The provided token is invalid, revoked, or expired.",
        fixCommand:
          "Create an agent token in Settings > Agent access, then run swizzle profile add <name> --url <api-url> --token <token>.",
      });
    }

    // A browser names the page behind every write in Origin; the CLI sends none. A write from a
    // foreign page is refused whatever credential it carries.
    const unsafe = UNSAFE_METHODS.has(request.method);
    if (unsafe && request.headers.origin !== undefined && !isAllowedBrowserOrigin(request)) {
      return respondOriginForbidden();
    }

    if (request.headers.cookie !== undefined) {
      const person = await options.auth.verifySession(requestHeaders(request));
      if (person !== null) {
        // The cookie rides along on any request, so a session write must name an allowed page.
        if (unsafe && !isAllowedBrowserOrigin(request)) {
          return respondOriginForbidden();
        }
        request.signedInPerson = person;
        request.actor = {
          kind: "person",
          label: person.user.email,
          role: person.user.role,
          token: null,
          userId: person.user.id,
        };
        return;
      }
    }

    if (rawApiToken !== undefined) {
      const actor = verified === null ? null : await tokenActor(options, verified);
      if (actor === "suspended") {
        // A new token would be refused too; only lifting the suspension helps.
        return respondAuthError({
          code: "AUTH_ACCOUNT_SUSPENDED",
          message: "The person this agent token belongs to is suspended.",
          fixCommand:
            "Ask an owner or admin of this instance to lift the suspension in Settings > People.",
        });
      }
      if (actor !== null) {
        if (routeAccess(request) === "session") return respondSessionRequired();
        request.actor = actor;
        return;
      }
      return respondAuthError({
        code: "FORBIDDEN",
        message:
          "The provided token is invalid, revoked, or expired, or its person or service account is gone.",
        fixCommand:
          "Create an agent token in Settings > Agent access, then run swizzle profile add <name> --url <api-url> --token <token>.",
      });
    }

    return respondAuthError({
      code: "UNAUTHORIZED",
      message: "Sign in to the dashboard or provide 'Authorization: Bearer <token>'.",
      fixCommand:
        "Create an agent token in Settings > Agent access, then run swizzle profile add <name> --url <api-url> --token <token>.",
    });
  });
}

/**
 * Who a verified token acts as, "suspended" while its person is, or null when nobody may act by it.
 * An agent token acts with its person's current role, so a demotion or suspension counts at once;
 * a service account token acts as the account in its project, whoever minted it.
 */
async function tokenActor(
  { accessStore, auth }: RegisterAuthGuardOptions,
  token: StoredApiToken,
): Promise<Actor | "suspended" | null> {
  if (token.holder.kind === "worker") return null;
  const acting = { id: token.id, name: token.name, scope: token.scope };
  if (token.holder.kind === "service-account") {
    const account = await accessStore.findServiceAccount(token.holder.serviceAccountId);
    if (account === null) return null;
    const { id, name, projectId } = account;
    return {
      kind: "service-account",
      label: name,
      projectId,
      serviceAccountId: id,
      token: acting,
    };
  }
  const person = await auth.findPerson(token.holder.userId);
  if (person === null) return null;
  if (person.suspended) return "suspended";
  return {
    kind: "person",
    label: person.email,
    role: person.role,
    token: acting,
    userId: person.id,
  };
}

function requestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  if (request.headers.cookie !== undefined) headers.set("cookie", request.headers.cookie);
  return headers;
}

function isDirectLoopbackReadinessRequest(request: FastifyRequest): boolean {
  const pathOnly = request.url.split("?")[0] ?? "/";
  if (request.method !== "GET" || pathOnly !== "/ready") return false;

  const remoteAddress = request.raw.socket.remoteAddress;
  if (remoteAddress === undefined) return false;
  if (remoteAddress === "::1") return true;
  const normalized = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  return normalized.startsWith("127.");
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

function isAllowedBrowserOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  return origin !== undefined && getAllowedOrigins().includes(origin);
}

interface AuthErrorPayload {
  readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "AUTH_ACCOUNT_SUSPENDED";
  readonly message: string;
  readonly fixCommand: string;
}

function respondAuthError(payload: AuthErrorPayload): never {
  throw new CodedError(payload.code, payload.message, {
    fixCommand: payload.fixCommand,
  });
}

function respondOriginForbidden(): never {
  throw new CodedError(
    "AUTH_ORIGIN_FORBIDDEN",
    "The request origin is not allowed to change data on this API.",
  );
}

function respondSessionRequired(): never {
  throw new CodedError(
    "AUTH_SESSION_REQUIRED",
    "This security-sensitive action requires a signed-in browser session.",
  );
}

/**
 * Whether session and device cookies carry `Secure`: SWIZZLE_AUTH_COOKIE_SECURE when set, else
 * whether a dashboard origin is HTTPS, since that is where the browser keeps them.
 */
export function resolveSecureCookies(environment: NodeJS.ProcessEnv = process.env): boolean {
  return (
    readBooleanSetting(environment, "SWIZZLE_AUTH_COOKIE_SECURE") ??
    getAllowedOrigins(environment).some((origin) => origin.startsWith("https://"))
  );
}

/** The auth guard has admitted this session route before its handler runs. */
export function browserSession(request: FastifyRequest): SignedInPerson {
  const person = request.signedInPerson;
  if (person === undefined) throw new Error("Session route ran without the auth guard.");
  return person;
}
