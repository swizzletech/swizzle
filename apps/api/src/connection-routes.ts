import { CodedError } from "@swizzle/db";
import { AutomationRuntimeError, parseRateLimitSpec } from "@swizzle/runtime";
import type {
  AuthorizeConnectionResponse,
  ConnectionAuthorizationRequest,
  ConnectionResponse,
  ConnectionsResponse,
  HtmlResponse,
  NoContentResponse,
  TestConnectionResponse,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";
import { connectionResponse } from "@swizzle/runtime/platform";
import type { FastifyRequest } from "fastify";

import { messagePage } from "./approval-page.js";
import { clientKey, createClientRateLimiter } from "./client-rate-limiter.js";
import { credentialPlace } from "./credential-routes.js";
import { type ApiServer, getEnvironment, publicApiUrl } from "./http-shared.js";
import { creatorOf } from "./request-access.js";
import { objectSchema, text, urlText } from "./request-validation.js";

const SWIZZLE_PUBLIC_URL_ENV = "SWIZZLE_PUBLIC_URL";

/**
 * The OAuth redirect_uri must be a stable, server-known absolute URL that matches what the
 * operator registered with the provider: `publicApiUrl`, with a proxy path such as /api kept, since
 * behind one the callback route is reachable only under it.
 */
function resolveConnectionPublicUrl(request: FastifyRequest): string {
  const base = publicApiUrl(request);
  if (base === null) {
    throw new AutomationRuntimeError(
      "CONNECTION_PUBLIC_URL_NOT_CONFIGURED",
      `${SWIZZLE_PUBLIC_URL_ENV} must be set to the public origin of this API (e.g. https://api.example.com) before OAuth connections can be authorized. In the self-hosted Compose stack this defaults to SWIZZLE_API_ORIGIN.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new AutomationRuntimeError(
      "CONNECTION_PUBLIC_URL_NOT_CONFIGURED",
      `${SWIZZLE_PUBLIC_URL_ENV} is not a valid URL: ${base}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AutomationRuntimeError(
      "CONNECTION_PUBLIC_URL_NOT_CONFIGURED",
      `${SWIZZLE_PUBLIC_URL_ENV} must use http(s): ${base}`,
    );
  }
  return base;
}

const CALLBACK_ERROR_MESSAGES: Record<string, { heading: string; message: string }> = {
  CONNECTION_CLIENT_CREDENTIALS_MISSING: {
    heading: "Authorization failed",
    message:
      "This connection is missing its client credentials. Re-enter the client id and secret under Connections and retry.",
  },
  CONNECTION_PROVIDER_UNKNOWN: {
    heading: "Authorization failed",
    message: "This connection uses an unknown provider. Recreate it under Connections and retry.",
  },
  CONNECTION_STATE_INVALID: {
    heading: "Link expired or already used",
    message:
      "This authorization link is no longer valid. Start a new authorization from the CLI or dashboard.",
  },
  PROVIDER_ACCESS_DENIED: {
    heading: "Access declined",
    message:
      "You declined access at the provider. No connection was authorized. You can retry at any time.",
  },
};

const CALLBACK_FALLBACK_ERROR = {
  heading: "Authorization failed",
  message:
    "The provider authorization could not be completed. Start a new authorization and try again.",
};

/**
 * Connections belong to a project and an environment, as secrets do: `?project=` names the
 * project, the default one when absent. Reading needs read there; authorizing a new connection
 * needs edit and gives the creator manage; re-authorizing or deleting one needs manage, testing
 * one needs use (packages/db/src/access.ts).
 */
export function registerConnectionRoutes(
  app: ApiServer,
  options: { readonly platform: PlatformServices },
): void {
  const { platform } = options;
  const projectQuery = { schema: { querystring: objectSchema({ project: urlText }) } };
  app.get<{ Reply: ConnectionsResponse }>("/connections", projectQuery, async (request) => {
    const environment = getEnvironment(request);
    const { project } = request.query as { project?: string };
    let projectIds: readonly string[] | "all";
    if (project !== undefined) {
      projectIds = [(await credentialPlace(request)).projectId];
    } else {
      const scope = await request.access.scope(environment);
      projectIds = scope.all ? "all" : scope.projectIds;
    }
    // The redirect base lets the dashboard show operators the exact redirect
    // URI to register in their provider console before they authorize. Listing
    // must keep working when SWIZZLE_PUBLIC_URL is not configured yet.
    let redirectBaseUrl: string | null;
    try {
      redirectBaseUrl = resolveConnectionPublicUrl(request);
    } catch {
      redirectBaseUrl = null;
    }
    const connections = await platform.listConnections(environment, projectIds);
    const rights = await request.access.credentialRights(
      connections.map((connection) => ({ ...connection, kind: "connection" })),
    );
    return {
      connections: connections.map((connection, index) => ({
        ...connectionResponse(connection),
        right: rights[index] ?? null,
      })),
      environment,
      redirectBaseUrl,
    };
  });

  app.get<{ Reply: ConnectionResponse }>(
    "/connections/:connectionName",
    projectQuery,
    async (request) => {
      const params = request.params as { connectionName: string };
      const place = await credentialPlace(request);
      const connection = await platform.getConnection(params.connectionName, place);
      if (connection === null) {
        throw new CodedError(
          "CONNECTION_NOT_FOUND",
          `Connection not found in environment ${place.environment}: ${params.connectionName}`,
        );
      }
      return connectionResponse(connection);
    },
  );

  const authorizeBody = {
    schema: {
      body: objectSchema({
        clientId: text,
        clientSecret: text,
        provider: text,
        providerConfig: { type: "object" },
        reuseFrom: text,
        scopes: { items: text, type: "array" },
      }),
      querystring: objectSchema({ project: urlText }),
    },
  };
  app.post<{ Reply: AuthorizeConnectionResponse }>(
    "/connections/:connectionName/authorize",
    authorizeBody,
    async (request) => {
      const params = request.params as { connectionName: string };
      const place = await credentialPlace(request);
      const body = (request.body ?? {}) as ConnectionAuthorizationRequest;
      const existing = await platform.getConnection(params.connectionName, place);
      if (existing === null) {
        await request.access.project(place.projectId, {
          action: "edit",
          environment: place.environment,
        });
      } else {
        await request.access.credential("connection", params.connectionName, place, "manage");
      }
      // Reusing client credentials copies a client secret, which only who manages its source may.
      const reuseFrom = body.reuseFrom?.trim();
      if (reuseFrom !== undefined) {
        await request.access.credential("connection", reuseFrom, place, "manage");
      }

      const result = await platform.beginConnectionAuthorization({
        ...(body.clientId === undefined ? {} : { clientId: body.clientId.trim() }),
        ...(body.clientSecret === undefined ? {} : { clientSecret: body.clientSecret }),
        ...creatorOf(request),
        name: params.connectionName,
        place,
        ...(body.provider === undefined ? {} : { provider: body.provider.trim() }),
        ...(body.providerConfig === undefined ? {} : { providerConfig: body.providerConfig }),
        publicUrl: resolveConnectionPublicUrl(request),
        reauthorizes: existing?.id ?? null,
        ...(reuseFrom === undefined ? {} : { reuseFrom }),
        scopes: body.scopes ?? [],
      });

      return {
        authorizationUrl: result.authorizationUrl,
        connection: connectionResponse(result.connection),
        expiresAt: result.expiresAt,
        redirectUri: result.redirectUri,
      };
    },
  );

  app.post<{ Reply: TestConnectionResponse }>(
    "/connections/:connectionName/test",
    projectQuery,
    async (request) => {
      const params = request.params as { connectionName: string };
      const place = await credentialPlace(request);
      await request.access.credential("connection", params.connectionName, place, "use");
      const result = await platform.testConnection(params.connectionName, place);
      return {
        accessTokenExpiresAt: result.accessTokenExpiresAt,
        connection: connectionResponse(result.connection),
        refreshed: result.refreshed,
      };
    },
  );

  app.delete<{ Reply: NoContentResponse }>(
    "/connections/:connectionName",
    projectQuery,
    async (request, reply) => {
      const params = request.params as { connectionName: string };
      const place = await credentialPlace(request);
      const checked = await request.access.credential(
        "connection",
        params.connectionName,
        place,
        "manage",
      );
      if (!(await platform.deleteConnection(checked.id))) {
        throw new CodedError(
          "CONNECTION_NOT_FOUND",
          `Connection not found: ${params.connectionName}`,
        );
      }
      reply.status(204);
      return null;
    },
  );

  // The provider issues `code` and `error` with no length limit (Microsoft's codes run past 1KB);
  // Node's 16KB header limit bounds them. `state` is ours.
  const providerText = { minLength: 1, pattern: urlText.pattern, type: "string" } as const;
  const callbackQuery = {
    schema: {
      querystring: objectSchema({ code: providerText, error: providerText, state: urlText }),
    },
  };
  const callbackLimiter = createClientRateLimiter(parseRateLimitSpec("oauth_callback", "30/min"));

  app.get<{ Reply: HtmlResponse }>(
    "/oauth/callback/:provider",
    callbackQuery,
    async (request, reply) => {
      reply.header("Referrer-Policy", "no-referrer");
      reply.type("text/html; charset=utf-8");

      if (!callbackLimiter.check(clientKey(request)).allowed) {
        reply.status(429);
        return messagePage({
          heading: "Too many requests",
          message: "Slow down and retry in a minute.",
        });
      }

      const params = request.params as { provider: string };
      const query = request.query as { code?: string; error?: string; state?: string } | undefined;

      const result = await platform.completeConnectionCallback({
        code: query?.code,
        providerError: query?.error,
        providerFromPath: params.provider,
        state: query?.state,
      });

      if (result.ok) {
        return messagePage({
          heading: `Connection "${result.connection.name}" is active`,
          message:
            "The authorization completed successfully. You can close this tab and return to your terminal or dashboard.",
        });
      }

      request.log.info(
        { errorCode: result.errorCode, provider: params.provider },
        "OAuth callback rejected.",
      );
      reply.status(400);
      const copy = CALLBACK_ERROR_MESSAGES[result.errorCode] ?? CALLBACK_FALLBACK_ERROR;
      return messagePage(copy);
    },
  );
}
