import { createHash } from "node:crypto";
import {
  ConnectionProviderError,
  normalizeProviderError,
  PROVIDER_REQUEST_TIMEOUT_MS,
  providerRejection,
} from "./errors.js";
import type { ConnectionProviderAdapter, ConnectionTokenSet } from "./types.js";

interface OAuth2AdapterConfig {
  readonly id: Exclude<ConnectionProviderAdapter["id"], "clickup">;
  readonly requiresScopes: boolean;
  readonly refreshScopes: boolean;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly pkce: boolean;
  readonly revokeUrl?: string;
}

type ClientCredentials = { readonly clientId: string; readonly clientSecret: string };
type Operation = "code exchange" | "token refresh" | "token revocation";

function parseTokenSet(payload: unknown): ConnectionTokenSet {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("access_token" in payload) ||
    typeof payload.access_token !== "string"
  ) {
    throw new ConnectionProviderError("OAuth provider returned an invalid access token", {
      kind: "transient",
    });
  }
  return {
    accessToken: payload.access_token,
    accessTokenExpiresAt:
      "expires_in" in payload && typeof payload.expires_in === "number"
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
    refreshToken:
      "refresh_token" in payload && typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : null,
    tokenType:
      "token_type" in payload && typeof payload.token_type === "string"
        ? payload.token_type
        : "bearer",
  };
}

async function requestOAuth2(
  endpoint: string,
  credentials: ClientCredentials,
  body: URLSearchParams,
  operation: Operation,
): Promise<unknown> {
  const signal = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  try {
    // RFC 6749 section 2.3.1 encodes each credential as a form value first.
    const formEncode = (value: string) => new URLSearchParams({ "": value }).toString().slice(1);
    const basic = Buffer.from(
      `${formEncode(credentials.clientId)}:${formEncode(credentials.clientSecret)}`,
    ).toString("base64");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": "Swizzle",
      },
      body,
      signal,
      redirect: "error",
    });
    if (operation === "token revocation" && response.ok) {
      await response.body?.cancel();
      return;
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel();
      throw new ConnectionProviderError(`OAuth provider ${operation} failed: ${response.status}`, {
        kind: "transient",
      });
    }
    const payload: unknown = await response.json();
    // GitHub can return OAuth errors with HTTP 200.
    if (
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
    ) {
      throw providerRejection(payload.error, operation);
    }
    if (!response.ok) {
      throw new ConnectionProviderError(`OAuth provider ${operation} failed: ${response.status}`, {
        kind: "transient",
      });
    }
    return payload;
  } catch (error) {
    throw normalizeProviderError(signal.aborted ? signal.reason : error, operation);
  }
}

/** Shared OAuth wire protocol with provider-specific consent and scope policy. */
export function createOAuth2Adapter(config: OAuth2AdapterConfig): ConnectionProviderAdapter {
  const { revokeUrl } = config;
  return {
    id: config.id,
    requiresScopes: config.requiresScopes,

    createAuthorizationUrl(input) {
      const url = new URL(config.authorizeUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", input.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("state", input.state);
      if (input.scopes.length > 0) {
        url.searchParams.set("scope", input.scopes.join(" "));
      }
      if (config.pkce) {
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set(
          "code_challenge",
          createHash("sha256").update(input.codeVerifier).digest("base64url"),
        );
      }
      return url;
    },

    async exchangeAuthorizationCode(input) {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
      });
      if (config.pkce) {
        body.set("code_verifier", input.codeVerifier);
      }
      return parseTokenSet(await requestOAuth2(config.tokenUrl, input, body, "code exchange"));
    },

    async refreshAccessToken(input) {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      });
      if (config.refreshScopes && input.scopes.length > 0) {
        body.set("scope", input.scopes.join(" "));
      }
      return parseTokenSet(await requestOAuth2(config.tokenUrl, input, body, "token refresh"));
    },

    ...(revokeUrl
      ? {
          async revokeToken(input) {
            await requestOAuth2(
              revokeUrl,
              input,
              new URLSearchParams({ token: input.token }),
              "token revocation",
            );
          },
        }
      : {}),
  };
}
