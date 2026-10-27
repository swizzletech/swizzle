import {
  ConnectionProviderError,
  normalizeProviderError,
  PROVIDER_REQUEST_TIMEOUT_MS,
} from "./errors.js";
import type {
  ConnectionProviderAdapter,
  ConnectionTokenSet,
  CreateAuthorizationUrlInput,
  ExchangeAuthorizationCodeInput,
  RefreshAccessTokenInput,
} from "./types.js";

// ClickUp has no PKCE, scopes, expiry or refresh token. Its token endpoint
// accepts client credentials in the request body.
const AUTHORIZE_ENDPOINT = "https://app.clickup.com/api";
const TOKEN_ENDPOINT = "https://api.clickup.com/api/v2/oauth/token";

interface ClickUpTokenResponse {
  readonly access_token?: unknown;
  readonly token_type?: unknown;
  readonly err?: unknown;
  readonly ECODE?: unknown;
}

export const clickupProviderAdapter: ConnectionProviderAdapter = {
  id: "clickup",
  requiresScopes: false,

  createAuthorizationUrl(input: CreateAuthorizationUrlInput): URL {
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    // ClickUp echoes state back to the callback, which our flow validates for
    // CSRF. It ignores scope and PKCE parameters.
    url.searchParams.set("state", input.state);
    return url;
  },

  async exchangeAuthorizationCode(
    input: ExchangeAuthorizationCodeInput,
  ): Promise<ConnectionTokenSet> {
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    });

    const signal = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw normalizeProviderError(signal.reason, "code exchange");
      }
      throw new ConnectionProviderError("ClickUp code exchange request failed", {
        cause: error,
        kind: "transient",
      });
    }

    let payload: ClickUpTokenResponse;
    try {
      payload = (await response.json()) as ClickUpTokenResponse;
    } catch (error) {
      if (signal.aborted) {
        throw normalizeProviderError(signal.reason, "code exchange");
      }
      throw new ConnectionProviderError("ClickUp returned a non-JSON token response", {
        cause: error,
        kind: response.ok ? "provider-rejected" : "transient",
      });
    }

    if (!response.ok || typeof payload.access_token !== "string") {
      const code = typeof payload.ECODE === "string" ? payload.ECODE : String(response.status);
      throw new ConnectionProviderError(`ClickUp rejected code exchange: ${code}`, {
        kind: response.status >= 500 ? "transient" : "provider-rejected",
        providerErrorCode: code,
      });
    }

    return {
      accessToken: payload.access_token,
      // ClickUp tokens do not expire and are not refreshable.
      accessTokenExpiresAt: null,
      refreshToken: null,
      tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    };
  },

  async refreshAccessToken(_input: RefreshAccessTokenInput): Promise<ConnectionTokenSet> {
    // Never reached in practice: with no expiry, the platform never schedules a
    // refresh. If access was revoked, the connection must be re-authorized.
    throw new ConnectionProviderError(
      "ClickUp access tokens do not expire and cannot be refreshed; re-authorize the connection if access was revoked",
      { kind: "invalid-grant" },
    );
  },
};
