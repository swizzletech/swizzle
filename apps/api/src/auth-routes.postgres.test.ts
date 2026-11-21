import { describe, expect, it, onTestFinished, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testApiTokenStore, testAuth } from "../../../test/stores.js";

import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";
import { DASHBOARD_ORIGIN, testBrowser } from "../test/browser.js";
import { ownerHeaders, testPeople } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

describe("api auth", () => {
  it("limits public status lookups by client address", async () => {
    vi.stubEnv("SWIZZLE_AUTH_STATUS_RATE_LIMIT", "2/min");
    vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", DASHBOARD_ORIGIN);
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = await buildTestServer();
    onTestFinished(async () => await app.close());
    const status = async (remoteAddress: string) =>
      await app.inject({
        headers: { origin: DASHBOARD_ORIGIN },
        method: "GET",
        url: "/auth/status",
        remoteAddress,
      });

    for (let request = 0; request < 2; request += 1) {
      expect((await status("203.0.113.45")).statusCode).toBe(200);
    }
    const limited = await status("203.0.113.45");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "AUTH_RATE_LIMITED" });
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.headers["access-control-expose-headers"]).toBe("Retry-After");
    expect((await status("203.0.113.46")).statusCode).toBe(200);
    vi.advanceTimersByTime(60_000);
    expect((await status("203.0.113.45")).statusCode).toBe(200);
  });

  it.each([
    { url: "/health", remoteAddress: "203.0.113.45", body: { service: "api", status: "ok" } },
    { url: "/auth/status", remoteAddress: "203.0.113.45", body: { authenticated: false } },
    { url: "/ready", remoteAddress: "127.0.0.1", body: { status: "ready" } },
  ])(
    "serves exempt $url without the bearer credential store",
    async ({ url, remoteAddress, body }) => {
      const tokens = testApiTokenStore();
      const verify = vi
        .spyOn(tokens, "verifyToken")
        .mockRejectedValue(new Error("Token database unavailable"));
      const app = await buildTestServer({ apiTokenStore: tokens });
      try {
        const response = await app.inject({
          method: "GET",
          url,
          remoteAddress,
          headers: { authorization: `Bearer swz_${"a".repeat(43)}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject(body);
        expect(verify).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it("keeps token administration to browser sessions, even on localhost", async () => {
    const apiTokenStore = testApiTokenStore();
    const people = testPeople();
    const app = await buildTestServer({
      apiTokenStore,
      auth: people.auth,
      platform: await testPlatform(),
    });
    const { authorization } = await people.bearer(apiTokenStore, "ada@example.com", "owner");
    const machineHeaders = { authorization };

    const created = await app.inject({
      headers: machineHeaders,
      method: "POST",
      payload: { name: "ci-runner" },
      url: "/auth/tokens",
    });
    expect(created.statusCode).toBe(403);
    expect(created.json()).toMatchObject({ error: "AUTH_SESSION_REQUIRED" });

    const listed = await app.inject({
      headers: machineHeaders,
      method: "GET",
      url: "/auth/tokens",
    });
    expect(listed.statusCode).toBe(403);

    const revoked = await app.inject({
      headers: machineHeaders,
      method: "DELETE",
      url: `/auth/tokens/ci-runner`,
    });
    expect(revoked.statusCode).toBe(403);

    await app.close();
  });

  it("requires a valid bearer token for local and remote machine requests", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const apiTokenStore = testApiTokenStore();
    const people = testPeople();
    const app = await buildTestServer({
      apiTokenStore,
      auth: people.auth,
      platform: await testPlatform(),
    });

    const noAuth = await app.inject({
      method: "GET",
      url: "/secrets",
      headers: {
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json()).toMatchObject({ error: "UNAUTHORIZED" });
    expect(noAuth.json().fixCommand).toContain("Settings > Agent access");

    const localNoAuth = await app.inject({ method: "GET", url: "/secrets" });
    expect(localNoAuth.statusCode).toBe(401);

    const badToken = await app.inject({
      method: "GET",
      url: "/secrets",
      headers: {
        authorization: "Bearer swz_invalid-token",
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    });
    expect(badToken.statusCode).toBe(403);
    expect(badToken.json()).toMatchObject({ error: "FORBIDDEN" });

    const { authorization } = await people.bearer(apiTokenStore, "ada@example.com", "owner");
    const okToken = await app.inject({
      method: "GET",
      url: "/secrets",
      headers: {
        authorization: authorization.replace(" ", "\t"),
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    });
    expect(okToken.statusCode).toBe(200);

    const agentSecret = await app.inject({
      method: "PUT",
      url: "/secrets/AGENT_MANAGED_KEY?environment=staging",
      headers: {
        authorization,
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      payload: { value: "secret-value-never-returned" },
      remoteAddress: "203.0.113.45",
    });
    expect(agentSecret.statusCode).toBe(200);
    expect(agentSecret.body).not.toContain("secret-value-never-returned");
    expect(agentSecret.json()).toMatchObject({
      environment: "staging",
      name: "AGENT_MANAGED_KEY",
    });
    expect(agentSecret.json()).not.toHaveProperty("ciphertext");
    expect(agentSecret.json()).not.toHaveProperty("value");

    const agentSecretList = await app.inject({
      method: "GET",
      url: "/secrets?environment=staging",
      headers: {
        authorization,
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    });
    expect(agentSecretList.statusCode).toBe(200);
    expect(agentSecretList.body).not.toContain("secret-value-never-returned");
    expect(agentSecretList.json()).toMatchObject({
      environment: "staging",
      secrets: [expect.objectContaining({ name: "AGENT_MANAGED_KEY", secretVersion: 1 })],
    });

    const agentSecretInspect = await app.inject({
      method: "GET",
      url: "/secrets/AGENT_MANAGED_KEY?environment=staging",
      headers: {
        authorization,
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    });
    expect(agentSecretInspect.statusCode).toBe(200);
    expect(agentSecretInspect.body).not.toContain("secret-value-never-returned");
    expect(agentSecretInspect.json()).toMatchObject({
      name: "AGENT_MANAGED_KEY",
      secretVersion: 1,
    });

    const agentSecretRotate = await app.inject({
      method: "PUT",
      url: "/secrets/AGENT_MANAGED_KEY?environment=staging",
      headers: {
        authorization,
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      payload: { value: "rotated-value-never-returned" },
      remoteAddress: "203.0.113.45",
    });
    expect(agentSecretRotate.statusCode).toBe(200);
    expect(agentSecretRotate.body).not.toContain("rotated-value-never-returned");
    expect(agentSecretRotate.json()).toMatchObject({ secretVersion: 2 });

    const agentSecretDelete = await app.inject({
      method: "DELETE",
      url: "/secrets/AGENT_MANAGED_KEY?environment=staging",
      headers: {
        authorization,
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    });
    expect(agentSecretDelete.statusCode).toBe(204);

    const healthRemote = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    });
    expect(healthRemote.statusCode).toBe(200);

    await app.close();
  });

  it("reports auth status on a public diagnostic endpoint", async () => {
    const app = await buildTestServer({
      auth: testAuth(),
      platform: await testPlatform(),
    });

    const missing = await app.inject({
      method: "GET",
      url: "/auth/status",
      headers: {
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(missing.headers["x-content-type-options"]).toBe("nosniff");
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect(missing.json()).toEqual({
      authenticated: false,
      mailConfigured: false,
      setupRequired: true,
      setupTokenRequired: false,
      user: null,
    });

    await app.close();
  });

  it("keeps sign-in budgets in the auth store, so a new server spends the same ones", async () => {
    vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", "http://127.0.0.1:5173");
    const auth = testAuth({ trustedOrigins: ["http://127.0.0.1:5173"] });
    const request = {
      headers: { origin: "http://127.0.0.1:5173" },
      method: "POST" as const,
      payload: { email: "ada@example.com", password: "wrong password value" },
      remoteAddress: "203.0.113.45",
      url: "/auth/sign-in/email",
    };
    const firstApp = await buildTestServer({ auth, platform: await testPlatform() });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await firstApp.inject(request)).statusCode).toBe(401);
    }

    const secondApp = await buildTestServer({ auth, platform: await testPlatform() });
    expect((await secondApp.inject(request)).statusCode).toBe(401);
    expect((await secondApp.inject(request)).statusCode).toBe(401);
    const limited = await secondApp.inject(request);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json()).toMatchObject({ error: "AUTH_RATE_LIMITED" });

    await Promise.all([firstApp.close(), secondApp.close()]);
  });

  it("requires auth for remote operator and readiness routes", async () => {
    const app = await buildTestServer({
      platform: await testPlatform(),
    });

    const remoteRequest = {
      headers: {
        "x-forwarded-for": "203.0.113.45",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    };

    const secrets = await app.inject({
      method: "GET",
      url: "/secrets",
      ...remoteRequest,
    });
    expect(secrets.statusCode).toBe(401);
    expect(secrets.json()).toMatchObject({ error: "UNAUTHORIZED" });

    const ready = await app.inject({
      method: "GET",
      url: "/ready",
      ...remoteRequest,
    });
    expect(ready.statusCode).toBe(401);

    const forgedLoopbackReady = await app.inject({
      method: "GET",
      url: "/ready",
      headers: {
        "x-forwarded-for": "127.0.0.1",
        host: "swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    });
    expect(forgedLoopbackReady.statusCode).toBe(401);

    const directLoopbackReady = await app.inject({
      method: "GET",
      url: "/ready",
      remoteAddress: "127.0.0.1",
    });
    expect(directLoopbackReady.statusCode).toBe(200);

    const metrics = await app.inject({
      method: "GET",
      url: "/metrics",
      ...remoteRequest,
    });
    expect(metrics.statusCode).toBe(401);

    const health = await app.inject({
      method: "GET",
      url: "/health",
      ...remoteRequest,
    });
    expect(health.statusCode).toBe(200);

    await app.close();
  });

  it("counts a malformed sign-in against the sign-in budget and answers 400", async () => {
    vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", "http://127.0.0.1:5173");
    const app = await buildTestServer({ platform: await testPlatform() });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        headers: { origin: "http://127.0.0.1:5173" },
        method: "POST",
        payload:
          attempt % 2 === 0
            ? { email: {}, password: [] }
            : { email: ["owner@example.com"], password: "a-valid-length-password" },
        remoteAddress: "203.0.113.45",
        url: "/auth/sign-in/email",
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);

    await app.close();
  });

  it("keeps authenticated responses out of browser caches", async () => {
    const apiTokenStore = testApiTokenStore();
    const people = testPeople();
    const app = await buildTestServer({
      apiTokenStore,
      auth: people.auth,
      platform: await testPlatform(),
    });
    const { authorization } = await people.bearer(apiTokenStore, "ada@example.com", "owner");

    const response = await app.inject({
      headers: { authorization },
      method: "GET",
      url: "/secrets",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");

    await app.close();
  });

  it("refuses a cookie-authenticated write without an Origin header", async () => {
    vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", DASHBOARD_ORIGIN);
    const people = testPeople();
    const app = await buildTestServer({ auth: people.auth });
    onTestFinished(() => app.close());
    const email = "owner@example.test";
    const password = "a long enough test passphrase";
    await people.add(email, { password, role: "owner" });
    const browser = testBrowser(app);
    expect((await browser.signIn(email, password)).statusCode).toBe(200);

    const url = "/automation-folders";
    const payload = { name: "Monthly reports" };
    const response = await app.inject({
      headers: {
        cookie: [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      },
      method: "POST",
      payload,
      remoteAddress: "203.0.113.45",
      url,
    });
    expect([response.statusCode, response.json().code]).toEqual([403, "AUTH_ORIGIN_FORBIDDEN"]);
    expect((await browser.send("POST", url, payload)).statusCode).toBe(201);
  });

  it("refuses a foreign Origin on unsafe requests with a valid token, and serves the CLI", async () => {
    vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", "http://127.0.0.1:5173");
    const app = await buildTestServer({ platform: await testPlatform() });
    const owner = await ownerHeaders();

    const foreign = await app.inject({
      headers: { ...owner, origin: "https://evil.example" },
      method: "POST",
      payload: { name: "from-a-web-page" },
      url: "/automation-folders",
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: "AUTH_ORIGIN_FORBIDDEN" });

    const cli = await app.inject({
      headers: owner,
      method: "POST",
      payload: { name: "from-the-cli" },
      url: "/automation-folders",
    });
    expect(cli.statusCode).toBe(201);

    await app.close();
  });
});
