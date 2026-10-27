import { randomUUID } from "node:crypto";
import type { ControlPlaneStore } from "@swizzle/db";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testControlPlaneStore } from "../../../test/stores.js";
import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";

import {
  beginPlatformConnectionAuthorization,
  buildConnectionRedirectUri,
  completePlatformConnectionCallback,
  connectionEnvVarName,
  resolvePlatformConnectionToken,
} from "./platform-connections.js";
import { buildPlatformChildEnvironment, upsertPlatformSecret } from "./platform-secrets.js";

const PUBLIC_URL = "https://api.example.com";
const LOCAL = { environment: "local", projectId: DEFAULT_PROJECT_ID };

async function connectionNamed(store: ControlPlaneStore, name: string) {
  const connection = await store.findCredential("connection", name, LOCAL);
  if (connection === null) throw new Error(`no connection ${name}`);
  return connection;
}

function extractState(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (state === null) {
    throw new Error("authorization URL had no state parameter");
  }
  return state;
}

function extractScope(authorizationUrl: string): string | null {
  return new URL(authorizationUrl).searchParams.get("scope");
}

function mockTokenResponse(body: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

async function authorizeAndComplete(
  store: ControlPlaneStore,
  name = "jan-google",
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const begun = await beginPlatformConnectionAuthorization({
    clientId: "client-id",
    clientSecret: "client-secret",
    place: LOCAL,
    name,
    provider: "google",
    publicUrl: PUBLIC_URL,
    reauthorizes: null,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    store,
    ...overrides,
  });
  mockTokenResponse({
    access_token: "access-token-1",
    expires_in: 3600,
    refresh_token: "refresh-token-1",
    token_type: "Bearer",
  });
  const result = await completePlatformConnectionCallback({
    code: "auth-code",
    providerFromPath: "google",
    state: extractState(begun.authorizationUrl),
    store,
  });
  expect(result.ok).toBe(true);
}

beforeEach(() => {
  vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
});

describe("connection naming", () => {
  it("maps connection names to env vars bijectively", () => {
    expect(connectionEnvVarName("jan-google")).toBe("SWIZZLE_CONNECTION_JAN_GOOGLE");
  });

  it("builds provider-scoped redirect URIs from the public URL", () => {
    expect(buildConnectionRedirectUri("https://api.example.com/", "google")).toBe(
      "https://api.example.com/oauth/callback/google",
    );
  });
});

describe("client credentials", () => {
  it("rejects new scope-requiring connections when no scopes are provided", async () => {
    const store = testControlPlaneStore();
    await expect(
      beginPlatformConnectionAuthorization({
        clientId: "client-id",
        clientSecret: "client-secret",
        place: LOCAL,
        name: "jan-google",
        provider: "google",
        publicUrl: PUBLIC_URL,
        reauthorizes: null,
        scopes: [],
        store,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_SCOPES_REQUIRED" });
  });

  it("reuses client credentials from another connection", async () => {
    const store = testControlPlaneStore();
    await authorizeAndComplete(store, "google-main");

    // Second account, same app: no client id/secret re-entered — copied over.
    await authorizeAndComplete(store, "google-work", {
      clientId: undefined,
      clientSecret: undefined,
      reuseFrom: "google-main",
      provider: undefined,
    });

    const work = await store.getConnection("google-work", LOCAL);
    expect(work?.status).toBe("active");
    expect(work?.clientId).toBe("client-id");
    const credentials = await store.getConnectionCredentials("google-work", LOCAL);
    expect(credentials?.clientSecret).toBe("client-secret");
  });

  it("rejects reuse from a non-existent connection", async () => {
    const store = testControlPlaneStore();
    await expect(
      beginPlatformConnectionAuthorization({
        place: LOCAL,
        name: "google-work",
        publicUrl: PUBLIC_URL,
        reauthorizes: null,
        reuseFrom: "does-not-exist",
        scopes: [],
        store,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_CLIENT_CREDENTIALS_MISSING" });
  });
});

describe("authorization flow", () => {
  // Google returns a refresh token only on a consented offline grant.
  it("forces consent and offline access on the first authorization", async () => {
    const store = testControlPlaneStore();
    const begun = await beginPlatformConnectionAuthorization({
      clientId: "client-id",
      clientSecret: "client-secret",
      place: LOCAL,
      name: "jan-google",
      provider: "google",
      publicUrl: PUBLIC_URL,
      reauthorizes: null,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      store,
    });

    const authorizationUrl = new URL(begun.authorizationUrl);
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
  });

  it("rejects replayed and unknown states", async () => {
    const store = testControlPlaneStore();
    const begun = await beginPlatformConnectionAuthorization({
      clientId: "client-id",
      clientSecret: "client-secret",
      place: LOCAL,
      name: "jan-google",
      provider: "google",
      publicUrl: PUBLIC_URL,
      reauthorizes: null,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      store,
    });
    const state = extractState(begun.authorizationUrl);

    mockTokenResponse({ access_token: "t", expires_in: 3600, token_type: "Bearer" });
    const first = await completePlatformConnectionCallback({
      code: "auth-code",
      providerFromPath: "google",
      state,
      store,
    });
    expect(first.ok).toBe(true);

    const replay = await completePlatformConnectionCallback({
      code: "auth-code",
      providerFromPath: "google",
      state,
      store,
    });
    expect(replay).toEqual({ errorCode: "CONNECTION_STATE_INVALID", ok: false });

    const unknown = await completePlatformConnectionCallback({
      code: "auth-code",
      providerFromPath: "google",
      state: "forged-state",
      store,
    });
    expect(unknown).toEqual({ errorCode: "CONNECTION_STATE_INVALID", ok: false });
  });

  // The API checks a right on the connection it found; one created since must not inherit it.
  it("refuses an authorization checked against another connection than the stored one", async () => {
    const store = testControlPlaneStore();
    await authorizeAndComplete(store);
    const attempt = beginPlatformConnectionAuthorization({
      clientId: "other-client",
      clientSecret: "other-secret",
      place: LOCAL,
      name: "jan-google",
      provider: "google",
      publicUrl: PUBLIC_URL,
      reauthorizes: null,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      store,
    });
    await expect(attempt).rejects.toMatchObject({ code: "CREDENTIAL_CHANGED" });
    expect((await store.getConnection("jan-google", LOCAL))?.clientId).toBe("client-id");
  });

  // The provider answers after a delay in which the connection can be deleted and recreated.
  it("stores the tokens of a callback only in the connection its authorization began on", async () => {
    const store = testControlPlaneStore();
    const begin = (clientId: string) =>
      beginPlatformConnectionAuthorization({
        clientId,
        clientSecret: "client-secret",
        place: LOCAL,
        name: "jan-google",
        provider: "google",
        publicUrl: PUBLIC_URL,
        reauthorizes: null,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        store,
      });
    const begun = await begin("first-client");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await store.deleteConnection((await connectionNamed(store, "jan-google")).id);
        await begin("second-client");
        return new Response(JSON.stringify({ access_token: "t", token_type: "Bearer" }));
      }),
    );

    const result = await completePlatformConnectionCallback({
      code: "auth-code",
      providerFromPath: "google",
      state: extractState(begun.authorizationUrl),
      store,
    });
    expect(result).toEqual({ errorCode: "CONNECTION_STATE_INVALID", ok: false });
    expect(await store.getConnection("jan-google", LOCAL)).toMatchObject({
      clientId: "second-client",
      status: "pending",
      tokenVersion: 0,
    });
  });

  it("reconnects using the stored credentials without re-entering them", async () => {
    const store = testControlPlaneStore();
    await authorizeAndComplete(store);
    // Reconnect supplies no credentials: the stored client id/secret are reused.
    const reconnect = await beginPlatformConnectionAuthorization({
      place: LOCAL,
      name: "jan-google",
      publicUrl: PUBLIC_URL,
      reauthorizes: (await connectionNamed(store, "jan-google")).id,
      scopes: [],
      store,
    });
    expect(extractScope(reconnect.authorizationUrl)).toBe(
      "https://www.googleapis.com/auth/drive.readonly",
    );

    const declined = await completePlatformConnectionCallback({
      providerError: "access_denied",
      providerFromPath: "google",
      state: extractState(reconnect.authorizationUrl),
      store,
    });

    expect(declined).toEqual({ errorCode: "PROVIDER_ACCESS_DENIED", ok: false });
    const connection = await store.getConnection("jan-google", LOCAL);
    expect(connection?.status).toBe("active");
    expect(connection?.lastErrorCode).toBe("PROVIDER_ACCESS_DENIED");
  });

  it("uses explicit scopes as the reconnect override", async () => {
    const store = testControlPlaneStore();
    await authorizeAndComplete(store);

    const reconnect = await beginPlatformConnectionAuthorization({
      place: LOCAL,
      name: "jan-google",
      publicUrl: PUBLIC_URL,
      reauthorizes: (await connectionNamed(store, "jan-google")).id,
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
      store,
    });

    expect(extractScope(reconnect.authorizationUrl)).toBe(
      "https://www.googleapis.com/auth/gmail.send",
    );
  });
});

describe("token resolution and refresh", () => {
  it("resolves without refresh while the token is fresh", async () => {
    const store = testControlPlaneStore();
    await authorizeAndComplete(store);

    const resolved = await resolvePlatformConnectionToken({
      connection: await connectionNamed(store, "jan-google"),
      store,
    });
    expect(resolved.refreshed).toBe(false);
    expect(resolved.token.accessToken).toBe("access-token-1");
  });

  it("refreshes expiring tokens and preserves the refresh token when omitted", async () => {
    const store = testControlPlaneStore();
    await authorizeAndComplete(store);

    mockTokenResponse({ access_token: "access-token-2", expires_in: 3600, token_type: "Bearer" });
    const resolved = await resolvePlatformConnectionToken({
      connection: await connectionNamed(store, "jan-google"),
      refreshSkewMs: Number.MAX_SAFE_INTEGER,
      store,
    });
    expect(resolved.refreshed).toBe(true);
    expect(resolved.token.accessToken).toBe("access-token-2");
    expect(resolved.token.tokenVersion).toBe(2);

    // A second forced refresh still works: the original refresh token survived.
    mockTokenResponse({ access_token: "access-token-3", expires_in: 3600, token_type: "Bearer" });
    const again = await resolvePlatformConnectionToken({
      connection: await connectionNamed(store, "jan-google"),
      refreshSkewMs: Number.MAX_SAFE_INTEGER,
      store,
    });
    expect(again.token.accessToken).toBe("access-token-3");
  });

  it("marks the connection unauthorized on invalid_grant", async () => {
    const store = testControlPlaneStore();
    await authorizeAndComplete(store);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    await expect(
      resolvePlatformConnectionToken({
        connection: await connectionNamed(store, "jan-google"),
        refreshSkewMs: Number.MAX_SAFE_INTEGER,
        store,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_CONNECTION_UNAUTHORIZED" });

    const connection = await store.getConnection("jan-google", LOCAL);
    expect(connection?.status).toBe("error");
  });

  it("keeps the connection active on transient refresh failures", async () => {
    const store = testControlPlaneStore();
    await authorizeAndComplete(store);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(
      resolvePlatformConnectionToken({
        connection: await connectionNamed(store, "jan-google"),
        refreshSkewMs: Number.MAX_SAFE_INTEGER,
        store,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_CONNECTION_REFRESH_FAILED" });

    const connection = await store.getConnection("jan-google", LOCAL);
    expect(connection?.status).toBe("active");
  });

  it("fails clearly for missing connections", async () => {
    const store = testControlPlaneStore();
    await expect(
      resolvePlatformConnectionToken({
        connection: { environment: "local", id: randomUUID(), name: "nope" },
        store,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_REQUIRED_CONNECTIONS_MISSING" });
  });
});

describe("child environment injection", () => {
  it("injects only the access token and expiry", () => {
    const childEnvironment = buildPlatformChildEnvironment({
      connections: [
        {
          accessToken: "access-token",
          accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
          environment: "local",
          name: "jan-google",
          provider: "google",
          tokenVersion: 3,
        },
      ],
      secrets: [],
    });

    expect(childEnvironment.SWIZZLE_CONNECTION_JAN_GOOGLE).toBe("access-token");
    expect(childEnvironment.SWIZZLE_CONNECTION_JAN_GOOGLE_EXPIRES_AT).toBe(
      "2030-01-01T00:00:00.000Z",
    );
    expect(Object.keys(childEnvironment)).toHaveLength(2);
  });
});

describe("guard rails", () => {
  it("rejects secrets shadowing the connection env prefix", async () => {
    const store = testControlPlaneStore();
    await expect(
      upsertPlatformSecret({
        name: "SWIZZLE_CONNECTION_FOO",
        place: { environment: "local", projectId: DEFAULT_PROJECT_ID },
        store,
        value: "nope",
      }),
    ).rejects.toMatchObject({ code: "SECRET_NAME_RESERVED" });
  });

  it("rejects invalid connection names", async () => {
    const store = testControlPlaneStore();
    await expect(
      beginPlatformConnectionAuthorization({
        clientId: "client-id",
        clientSecret: "client-secret",
        name: "Jan_Google",
        place: LOCAL,
        provider: "google",
        publicUrl: PUBLIC_URL,
        reauthorizes: null,
        scopes: [],
        store,
      }),
    ).rejects.toMatchObject({ code: "AUTOMATION_CONFIG_INVALID" });
  });
});
