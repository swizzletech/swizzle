import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldDeadlines } from "../../../test/support.js";
import { parseCustomOAuth2ProviderConfig } from "./custom-oauth2.js";
import { ConnectionProviderError, PROVIDER_REQUEST_TIMEOUT_MS } from "./errors.js";
import { parseMicrosoftProviderConfig } from "./microsoft.js";
import { getConnectionProviderAdapter } from "./registry.js";
import type { ConnectionProviderAdapter } from "./types.js";

const BASE_AUTH_INPUT = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://api.example.com/oauth/callback/google",
  state: "state-value",
  // RFC 7636 Appendix B test vector.
  codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  scopes: ["scope:first", "scope:second"],
  forceConsent: false,
};

const CODE_INPUT = { ...BASE_AUTH_INPUT, code: "auth-code &+" };
const REFRESH_INPUT = { ...BASE_AUTH_INPUT, refreshToken: "refresh-token &+" };

describe("registry", () => {
  it("rejects unknown providers", () => {
    expect(() => getConnectionProviderAdapter("slack")).toThrowError(ConnectionProviderError);
  });

  it("requires endpoint config for custom-oauth2", () => {
    expect(() => getConnectionProviderAdapter("custom-oauth2")).toThrowError(
      /requires providerConfig/,
    );
  });
});

describe("provider configuration", () => {
  it("defaults to the common tenant and validates overrides", () => {
    expect(parseMicrosoftProviderConfig(undefined).tenant).toBe("common");
    expect(parseMicrosoftProviderConfig({ tenant: "contoso.onmicrosoft.com" }).tenant).toBe(
      "contoso.onmicrosoft.com",
    );
    expect(() => parseMicrosoftProviderConfig({ tenant: "bad/tenant" })).toThrowError(
      ConnectionProviderError,
    );
    const url = getConnectionProviderAdapter("microsoft").createAuthorizationUrl(BASE_AUTH_INPUT);
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
  });
  const providerConfig = {
    authorizeUrl: "https://auth.example.com/oauth/authorize",
    tokenUrl: "https://auth.example.com/oauth/token",
  };
  it("validates provider config", () => {
    expect(() => parseCustomOAuth2ProviderConfig({ authorizeUrl: "not-a-url" })).toThrowError(
      ConnectionProviderError,
    );
    expect(() =>
      parseCustomOAuth2ProviderConfig({ authorizeUrl: providerConfig.authorizeUrl }),
    ).toThrowError(/authorizeUrl and tokenUrl/);
    expect(() =>
      parseCustomOAuth2ProviderConfig({
        authorizeUrl: "http://auth.example.com/oauth/authorize",
        tokenUrl: providerConfig.tokenUrl,
      }),
    ).toThrowError(/must use https/u);
    expect(() =>
      parseCustomOAuth2ProviderConfig({
        authorizeUrl: "https://user:password@auth.example.com/oauth/authorize",
        tokenUrl: providerConfig.tokenUrl,
      }),
    ).toThrowError(/must not contain URL credentials/u);
  });
});

describe("clickup adapter", () => {
  it("builds an authorization URL with state and no scope", () => {
    const adapter = getConnectionProviderAdapter("clickup");
    const url = adapter.createAuthorizationUrl(BASE_AUTH_INPUT);
    expect(url.origin).toBe("https://app.clickup.com");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("exchanges a code for a non-expiring token via the token endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ access_token: "cu-token", token_type: "Bearer" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = getConnectionProviderAdapter("clickup");
    const tokens = await adapter.exchangeAuthorizationCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://api.example.com/oauth/callback/clickup",
      code: "code",
      codeVerifier: "verifier",
    });
    expect(tokens.accessToken).toBe("cu-token");
    expect(tokens.accessTokenExpiresAt).toBeNull();
    expect(tokens.refreshToken).toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.clickup.com/api/v2/oauth/token");
  });

  it("classifies a rejected code exchange as provider-rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ err: "Bad", ECODE: "OAUTH_017" }), { status: 400 }),
      ),
    );
    const adapter = getConnectionProviderAdapter("clickup");
    await expect(
      adapter.exchangeAuthorizationCode({
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://api.example.com/oauth/callback/clickup",
        code: "bad-code",
        codeVerifier: "verifier",
      }),
    ).rejects.toMatchObject({ name: "ConnectionProviderError", kind: "provider-rejected" });
  });

  it("refuses to refresh because ClickUp tokens do not expire", async () => {
    const adapter = getConnectionProviderAdapter("clickup");
    await expect(
      adapter.refreshAccessToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "n/a",
        scopes: [],
      }),
    ).rejects.toMatchObject({ name: "ConnectionProviderError", kind: "invalid-grant" });
  });
});

const PROVIDERS = [
  {
    id: "github",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenPath: "/login/oauth/access_token",
    origin: "https://github.com",
  },
  {
    id: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenPath: "/token",
    origin: "https://oauth2.googleapis.com",
  },
  {
    id: "microsoft",
    authorizeUrl: "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize",
    tokenPath: "/contoso.onmicrosoft.com/oauth2/v2.0/token",
    origin: "https://login.microsoftonline.com",
  },
  {
    id: "custom-oauth2",
    authorizeUrl: "https://auth.example.com/authorize?audience=example",
    tokenPath: "/custom/token",
    origin: null,
  },
] as const;

describe.each(PROVIDERS)("$id against a local token endpoint", (provider) => {
  let server: Server;
  let localOrigin: string;
  let adapter: ConnectionProviderAdapter;
  let status: number;
  let payload: unknown;
  let disconnect: boolean;
  let requests: {
    method: string | undefined;
    path: string | undefined;
    body: string;
    headers: unknown;
  }[];
  let destinations: string[];

  beforeEach(async () => {
    status = 200;
    payload = { access_token: "access-token" };
    disconnect = false;
    requests = [];
    destinations = [];
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, path: request.url, body, headers: request.headers });
      if (disconnect) {
        request.socket.destroy();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
    localOrigin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("SWIZZLE_ALLOW_INSECURE_OAUTH_ENDPOINTS", "true");
    adapter = getConnectionProviderAdapter(
      provider.id,
      provider.id === "custom-oauth2"
        ? {
            authorizeUrl: provider.authorizeUrl,
            tokenUrl: `${localOrigin}${provider.tokenPath}`,
            revokeUrl: `${localOrigin}/revoke`,
          }
        : { tenant: "contoso.onmicrosoft.com" },
    );
    // Only reroute built-in hosts. The actual fetch, HTTP exchange and response
    // parsing run unchanged; custom OAuth uses its configured local URL directly.
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      destinations.push(request.url);
      const url = new URL(request.url);
      return nativeFetch(new Request(`${localOrigin}${url.pathname}${url.search}`, request));
    });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("builds the authorize URL with state, redirect, scopes and the RFC PKCE challenge", () => {
    const url = adapter.createAuthorizationUrl(BASE_AUTH_INPUT);
    const expectedUrl = new URL(provider.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${expectedUrl.origin}${expectedUrl.pathname}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ...(provider.id === "custom-oauth2" ? { audience: "example" } : {}),
      response_type: "code",
      client_id: "client-id",
      redirect_uri: BASE_AUTH_INPUT.redirectUri,
      state: "state-value",
      scope:
        provider.id === "microsoft"
          ? "scope:first scope:second offline_access"
          : "scope:first scope:second",
      ...(provider.id === "github"
        ? {}
        : {
            code_challenge_method: "S256",
            code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          }),
      ...(provider.id === "google" ? { access_type: "offline" } : {}),
    });
    const consentUrl = adapter.createAuthorizationUrl({
      ...BASE_AUTH_INPUT,
      scopes: provider.id === "microsoft" ? ["offline_access"] : [],
      forceConsent: true,
    });
    expect(consentUrl.searchParams.get("prompt")).toBe(
      provider.id === "google" || provider.id === "microsoft" ? "consent" : null,
    );
    expect(consentUrl.searchParams.get("scope")).toBe(
      provider.id === "microsoft" ? "offline_access" : null,
    );
  });

  it("exchanges the code using Basic auth and a form body, and maps expiring tokens", async () => {
    payload = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    };
    const start = Date.now();
    const tokens = await adapter.exchangeAuthorizationCode(CODE_INPUT);
    expect(tokens).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: expect.any(Date),
      tokenType: "Bearer",
    });
    expect(tokens.accessTokenExpiresAt?.getTime()).toBeGreaterThanOrEqual(start + 3_600_000);
    expect(tokens.accessTokenExpiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(destinations).toEqual([`${provider.origin ?? localOrigin}${provider.tokenPath}`]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: provider.tokenPath,
      headers: {
        authorization: "Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=",
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": "Swizzle",
      },
    });
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({
      grant_type: "authorization_code",
      code: "auth-code &+",
      redirect_uri: BASE_AUTH_INPUT.redirectUri,
      ...(provider.id === "github" ? {} : { code_verifier: BASE_AUTH_INPUT.codeVerifier }),
    });
  });

  it("form-encodes reserved characters in Basic credentials for exchange, refresh and revocation", async () => {
    const credentials = {
      clientId: "client:id +%&ä",
      clientSecret: "secret: +%&=ß",
    };
    expect(
      await adapter.exchangeAuthorizationCode({ ...CODE_INPUT, ...credentials }),
    ).toMatchObject({
      accessToken: "access-token",
    });
    expect(await adapter.refreshAccessToken({ ...REFRESH_INPUT, ...credentials })).toMatchObject({
      accessToken: "access-token",
    });
    if (adapter.revokeToken) {
      await adapter.revokeToken({ ...credentials, token: "revoke-token" });
    }
    expect(requests).toHaveLength(
      provider.id === "google" || provider.id === "custom-oauth2" ? 3 : 2,
    );
    for (const request of requests) {
      expect(request).toMatchObject({
        headers: {
          authorization:
            "Basic Y2xpZW50JTNBaWQrJTJCJTI1JTI2JUMzJUE0OnNlY3JldCUzQSslMkIlMjUlMjYlM0QlQzMlOUY=",
        },
      });
    }
  });

  it("maps non-expiring tokens and defaults an omitted token type", async () => {
    expect(await adapter.exchangeAuthorizationCode(CODE_INPUT)).toEqual({
      accessToken: "access-token",
      accessTokenExpiresAt: null,
      refreshToken: null,
      tokenType: "bearer",
    });
  });

  it("refreshes with the provider's scope policy and maps rotated or omitted refresh tokens", async () => {
    payload = { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 600 };
    const start = Date.now();
    const tokens = await adapter.refreshAccessToken(REFRESH_INPUT);
    expect(tokens).toEqual({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      accessTokenExpiresAt: expect.any(Date),
      tokenType: "bearer",
    });
    expect(tokens.accessTokenExpiresAt?.getTime()).toBeGreaterThanOrEqual(start + 600_000);
    expect(tokens.accessTokenExpiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(destinations).toEqual([`${provider.origin ?? localOrigin}${provider.tokenPath}`]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: provider.tokenPath,
      headers: { authorization: "Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=" },
    });
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-token &+",
      ...(provider.id === "microsoft"
        ? { scope: "scope:first scope:second offline_access" }
        : provider.id === "custom-oauth2"
          ? { scope: "scope:first scope:second" }
          : {}),
    });
    payload = { access_token: "next-access" };
    expect(await adapter.refreshAccessToken({ ...REFRESH_INPUT, scopes: [] })).toEqual({
      accessToken: "next-access",
      refreshToken: null,
      accessTokenExpiresAt: null,
      tokenType: "bearer",
    });
    expect(new URLSearchParams(requests[1]?.body).get("scope")).toBe(
      provider.id === "microsoft" ? "offline_access" : null,
    );
  });

  it.each([
    {
      status: 400,
      payload: { error: "invalid_grant" },
      kind: "invalid-grant",
      code: "invalid_grant",
    },
    {
      status: 401,
      payload: { error: "invalid_token" },
      kind: "invalid-grant",
      code: "invalid_token",
    },
    {
      status: 401,
      payload: { error: "invalid_client" },
      kind: "provider-rejected",
      code: "invalid_client",
    },
    {
      status: 200,
      payload: { error: "access_denied" },
      kind: "provider-rejected",
      code: "access_denied",
    },
    { status: 503, payload: { error: "invalid_grant" }, kind: "transient", code: null },
    { status: 429, payload: { error: "invalid_grant" }, kind: "transient", code: null },
    { status: 400, payload: {}, kind: "transient", code: null },
    { status: 200, payload: "not-json", kind: "transient", code: null },
    { status: 200, payload: { access_token: 42 }, kind: "transient", code: null },
    { status: 200, payload: null, kind: "transient", code: null },
  ])("maps HTTP $status / $payload to $kind for exchange and refresh", async (failure) => {
    status = failure.status;
    payload = failure.payload;
    for (const operation of [
      () => adapter.exchangeAuthorizationCode(CODE_INPUT),
      () => adapter.refreshAccessToken(REFRESH_INPUT),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        name: "ConnectionProviderError",
        kind: failure.kind,
        providerErrorCode: failure.code,
      });
    }
    expect(requests).toHaveLength(2);
  });

  it("maps a dropped HTTP connection to transient for exchange and refresh", async () => {
    disconnect = true;
    await expect(adapter.exchangeAuthorizationCode(CODE_INPUT)).rejects.toMatchObject({
      name: "ConnectionProviderError",
      kind: "transient",
      providerErrorCode: null,
    });
    await expect(adapter.refreshAccessToken(REFRESH_INPUT)).rejects.toMatchObject({
      name: "ConnectionProviderError",
      kind: "transient",
      providerErrorCode: null,
    });
  });

  if (provider.id === "google" || provider.id === "custom-oauth2") {
    it("revokes with Basic auth and maps revocation errors", async () => {
      const revoke = adapter.revokeToken;
      if (!revoke) throw new Error("Missing revocation support");
      const input = { ...BASE_AUTH_INPUT, token: "revoke-token &+" };
      payload = "";
      await revoke(input);
      expect(destinations).toEqual([`${provider.origin ?? localOrigin}/revoke`]);
      expect(requests[0]).toMatchObject({
        method: "POST",
        path: "/revoke",
        headers: { authorization: "Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=" },
      });
      expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({
        token: "revoke-token &+",
      });
      status = 400;
      payload = { error: "invalid_token" };
      await expect(revoke(input)).rejects.toMatchObject({
        kind: "invalid-grant",
        providerErrorCode: "invalid_token",
      });
    });
  }
});

describe.each(["custom-oauth2", "clickup"] as const)("%s request timeout", (provider) => {
  let server: Server;
  let origin: string;
  let stallBody: boolean;
  // The provider's deadline ends once the stall is in place: at the request for the headers, and
  // once the headers arrived for the body.
  let deadlines: ReturnType<typeof heldDeadlines>;

  beforeEach(async () => {
    stallBody = false;
    server = createServer((_request, response) => {
      if (stallBody) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"access_token":');
      } else deadlines.expire();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
    origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("SWIZZLE_ALLOW_INSECURE_OAUTH_ENDPOINTS", "true");
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await nativeFetch(origin, init);
      if (stallBody) deadlines.expire();
      return response;
    });
    deadlines = heldDeadlines(PROVIDER_REQUEST_TIMEOUT_MS);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it.each(["headers", "body"])(
    "reports a transient timeout when the provider stalls the %s",
    async (phase) => {
      stallBody = phase === "body";
      const adapter = getConnectionProviderAdapter(
        provider,
        provider === "custom-oauth2" ? { authorizeUrl: origin, tokenUrl: origin } : undefined,
      );
      await expect(adapter.exchangeAuthorizationCode(CODE_INPUT)).rejects.toMatchObject({
        name: "ConnectionProviderError",
        kind: "transient",
        message: "OAuth provider code exchange timed out after 10000ms",
      });
    },
  );
});
