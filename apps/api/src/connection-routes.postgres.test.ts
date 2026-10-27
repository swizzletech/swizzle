import type { ConnectionsResponse } from "@swizzle/runtime/http-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";

import { testAccessStore } from "../../../test/stores.js";
import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";
import { ownerHeaders } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

let owner: { readonly authorization: string };
beforeEach(async () => {
  owner = await ownerHeaders();
});

const GOOGLE_CREDENTIALS = {
  clientId: "client-id",
  clientSecret: "client-secret",
  provider: "google",
} as const;

function mockTokenResponse(body: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

describe("connection routes", () => {
  it("reads project refs with connections when connections share a project", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("SWIZZLE_PUBLIC_URL", "https://api.example.com");
    const accessStore = testAccessStore();
    await accessStore.createProject({ slug: "billing", name: "Billing" });
    const app = await buildTestServer({ accessStore, platform: await testPlatform() });
    try {
      for (const [name, project] of [
        ["billing-main", "billing"],
        ["billing-work", "billing"],
        ["default-main", "default"],
      ]) {
        const response = await app.inject({
          headers: owner,
          method: "POST",
          payload: { ...GOOGLE_CREDENTIALS, scopes: ["openid"] },
          url: `/connections/${name}/authorize?project=${project}`,
        });
        expect(response.statusCode).toBe(200);
      }
      const getProject = vi.spyOn(accessStore, "getProject");
      const listProjects = vi.spyOn(accessStore, "listProjects");
      const response = await app.inject({ headers: owner, method: "GET", url: "/connections" });
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json<ConnectionsResponse>()
          .connections.map((connection) => ({
            name: connection.name,
            project: connection.project.slug,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: "billing-main", project: "billing" },
        { name: "billing-work", project: "billing" },
        { name: "default-main", project: "default" },
      ]);
      expect({
        individualLookups: getProject.mock.calls.length,
        bulkLookups: listProjects.mock.calls.length,
      }).toEqual({ individualLookups: 0, bulkLookups: 0 });
    } finally {
      await app.close();
    }
  });

  it("supports the full authorize -> callback -> inspect -> delete flow", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("SWIZZLE_PUBLIC_URL", "https://api.example.com");
    const app = await buildTestServer({ platform: await testPlatform() });

    const authorizeResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: {
        ...GOOGLE_CREDENTIALS,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
      url: "/connections/jan-google/authorize",
    });
    expect(authorizeResponse.statusCode).toBe(200);
    const authorizeBody = authorizeResponse.json();
    expect(authorizeBody.redirectUri).toBe("https://api.example.com/oauth/callback/google");
    expect(authorizeBody.connection.status).toBe("pending");
    expect(authorizeBody.connection.clientId).toBe("client-id");
    expect(authorizeBody.authorizationUrl).toContain("accounts.google.com");
    expect(JSON.stringify(authorizeBody)).not.toContain("codeVerifier");
    expect(JSON.stringify(authorizeBody)).not.toContain("client-secret");

    const state = new URL(authorizeBody.authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    mockTokenResponse({
      access_token: "access-token",
      expires_in: 3600,
      refresh_token: "refresh-token",
      token_type: "Bearer",
    });
    const callbackResponse = await app.inject({
      headers: owner,
      method: "GET",
      // Providers such as Microsoft issue codes longer than other URL values.
      url: `/oauth/callback/google?state=${state}&code=${"c".repeat(2_000)}`,
    });
    expect(callbackResponse.statusCode).toBe(200);
    expect(callbackResponse.headers["content-type"]).toContain("text/html");
    expect(callbackResponse.headers["cache-control"]).toBe("no-store");
    // The approval page's frame: the mark, and the name as text.
    expect(callbackResponse.body).toContain('class="mark"');
    expect(callbackResponse.body).toContain("<h1>Connection &quot;jan-google&quot; is active</h1>");
    expect(callbackResponse.body).not.toContain("<script>");
    expect(callbackResponse.body).not.toContain("access-token");

    const listResponse = await app.inject({ headers: owner, method: "GET", url: "/connections" });
    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json();
    expect(listBody.connections).toHaveLength(1);
    expect(listBody.redirectBaseUrl).toBe("https://api.example.com");
    expect(listBody.connections[0]).toMatchObject({
      clientId: "client-id",
      name: "jan-google",
      provider: "google",
      status: "active",
      tokenVersion: 1,
    });
    expect(JSON.stringify(listBody)).not.toContain("access-token");
    expect(JSON.stringify(listBody)).not.toContain("refresh-token");
    expect(JSON.stringify(listBody)).not.toContain("client-secret");

    mockTokenResponse({ access_token: "access-token-2", expires_in: 3600, token_type: "Bearer" });
    const testResponse = await app.inject({
      headers: owner,
      method: "POST",
      url: "/connections/jan-google/test",
    });
    expect(testResponse.statusCode).toBe(200);
    expect(testResponse.json()).toMatchObject({ refreshed: true });
    expect(JSON.stringify(testResponse.json())).not.toContain("access-token");

    const deleteResponse = await app.inject({
      headers: owner,
      method: "DELETE",
      url: "/connections/jan-google",
    });
    expect(deleteResponse.statusCode).toBe(204);

    const missingResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/connections/jan-google",
    });
    expect(missingResponse.statusCode).toBe(404);

    await app.close();
  });

  it("reuses credentials from another connection without re-entering them", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("SWIZZLE_PUBLIC_URL", "https://api.example.com");
    const app = await buildTestServer({ platform: await testPlatform() });

    const first = await app.inject({
      headers: owner,
      method: "POST",
      payload: {
        ...GOOGLE_CREDENTIALS,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
      url: "/connections/google-main/authorize",
    });
    expect(first.statusCode).toBe(200);

    // Second account: no client id/secret, just point at the first connection.
    const second = await app.inject({
      headers: owner,
      method: "POST",
      payload: {
        reuseFrom: "google-main",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
      url: "/connections/google-work/authorize",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().connection.clientId).toBe("client-id");
    expect(second.json().connection.provider).toBe("google");
    expect(JSON.stringify(second.json())).not.toContain("client-secret");

    await app.close();
  });

  it("rejects callbacks with unknown or replayed state via generic HTML", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const app = await buildTestServer({ platform: await testPlatform() });

    const response = await app.inject({
      headers: owner,
      method: "GET",
      url: "/oauth/callback/google?state=forged&code=nope",
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("no longer valid");
    expect(response.body).not.toContain("forged");

    await app.close();
  });

  it("requires client credentials on the first authorize", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("SWIZZLE_PUBLIC_URL", "https://api.example.com");
    const app = await buildTestServer({ platform: await testPlatform() });

    const response = await app.inject({
      headers: owner,
      method: "POST",
      payload: {},
      url: "/connections/jan-google/authorize",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "CONNECTION_CLIENT_CREDENTIALS_MISSING" });

    await app.close();
  });

  it("rejects an unknown provider on authorize", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("SWIZZLE_PUBLIC_URL", "https://api.example.com");
    const app = await buildTestServer({ platform: await testPlatform() });

    const response = await app.inject({
      headers: owner,
      method: "POST",
      payload: { clientId: "id", clientSecret: "secret", provider: "slack" },
      url: "/connections/slack-ops/authorize",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "CONNECTION_PROVIDER_UNKNOWN" });

    await app.close();
  });

  it("fails with an actionable error when SWIZZLE_PUBLIC_URL is unset on a non-localhost host", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("SWIZZLE_PUBLIC_URL", undefined);
    const app = await buildTestServer({ platform: await testPlatform() });

    const response = await app.inject({
      headers: { ...owner, host: "api.example.com" },
      method: "POST",
      payload: GOOGLE_CREDENTIALS,
      url: "/connections/jan-google/authorize",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "CONNECTION_PUBLIC_URL_NOT_CONFIGURED" });

    // Listing keeps working without a configured public URL; the dashboard
    // gets null and shows a configuration hint instead of a redirect URI.
    const listResponse = await app.inject({
      headers: { ...owner, host: "api.example.com" },
      method: "GET",
      url: "/connections",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().redirectBaseUrl).toBeNull();

    await app.close();
  });

  // The tailnet install serves the API under /api of the dashboard's name (install.md). A query
  // or fragment in the setting would swallow the callback path appended to it.
  it.each([
    "https://server.example-tailnet.ts.net/api/",
    "https://server.example-tailnet.ts.net/api?x=1",
    "https://server.example-tailnet.ts.net/api#top",
  ])(
    "keeps only the proxy path of SWIZZLE_PUBLIC_URL %s in the redirect URI",
    async (publicUrl) => {
      vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
      vi.stubEnv("SWIZZLE_PUBLIC_URL", publicUrl);
      const app = await buildTestServer({ platform: await testPlatform() });

      const response = await app.inject({
        headers: owner,
        method: "POST",
        payload: {
          ...GOOGLE_CREDENTIALS,
          scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        },
        url: "/connections/jan-google/authorize",
      });
      expect(response.json().redirectUri).toBe(
        "https://server.example-tailnet.ts.net/api/oauth/callback/google",
      );

      await app.close();
    },
  );

  it("derives the redirect URI from localhost requests when SWIZZLE_PUBLIC_URL is unset", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("SWIZZLE_PUBLIC_URL", undefined);
    const app = await buildTestServer({ platform: await testPlatform() });

    const response = await app.inject({
      headers: { ...owner, host: "localhost:3000" },
      method: "POST",
      payload: {
        ...GOOGLE_CREDENTIALS,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
      url: "/connections/jan-google/authorize",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().redirectUri).toBe("http://localhost:3000/oauth/callback/google");

    await app.close();
  });
});
