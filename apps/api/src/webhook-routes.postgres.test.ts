import { createHmac } from "node:crypto";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { DEFAULT_PROJECT_ID } from "@swizzle/db";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { testApiTokenStore } from "../../../test/stores.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

import { deployFixture } from "../test/automations.js";

import { ownerHeaders, testPeople } from "../test/people.js";

import { buildTestServer } from "../test/server-harness.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

const appRoot = path.resolve(sourceRoot, "..");

const repoRoot = path.resolve(appRoot, "../..");

let owner: { readonly authorization: string };

beforeEach(async () => {
  owner = await ownerHeaders();
});

describe("webhook routes", () => {
  it("returns an opaque 404 when triggering an unknown webhook path", async () => {
    const app = await buildTestServer({
      platform: await testPlatform(),
    });
    const response = await app.inject({
      headers: owner,
      method: "POST",
      payload: { hello: "world" },
      url: "/unknown-path",
    });

    // The public ingress must not act as an existence oracle: unknown paths return
    // the same opaque WEBHOOK_NOT_AVAILABLE as a real-but-not-ready webhook, and the
    // response never names an automation or a trigger.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "WEBHOOK_NOT_AVAILABLE",
      error: "WEBHOOK_NOT_AVAILABLE",
    });
    expect(JSON.stringify(response.json())).not.toContain("TRIGGER_NOT_FOUND");

    await app.close();
  });

  it("stores forwarded webhook headers and exact raw JSON body for webhook runs", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });

    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );

    const rawBody = '{\n  "hello": "world"\n}';
    const response = await app.inject({
      headers: {
        authorization: "Bearer should-not-forward",
        "close-sig-hash": "abc123",
        cookie: "session=should-not-forward",
        "content-type": "application/json",
        "proxy-authorization": "Basic should-not-forward",
        "stripe-signature": "t=123,v1=abc",
        "x-hub-signature-256": "sha256=def",
      },
      method: "POST",
      payload: rawBody,
      url: "/hello",
    });

    expect(response.statusCode).toBe(200);
    const { runId } = response.json() as { runId: string };
    const run = await platform.getPlatformRun(runId);

    expect(run.payload).toEqual({ hello: "world" });
    expect(run.webhookContext).toMatchObject({
      headers: {
        // Forwarded although no allowlist ever named it — provider headers are the
        // automation's business, not the platform's.
        "close-sig-hash": "abc123",
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=abc",
        "x-hub-signature-256": "sha256=def",
      },
      rawBodyBase64: Buffer.from(rawBody).toString("base64"),
      rawBodyByteLength: Buffer.byteLength(rawBody),
    });
    expect(run.webhookContext?.headers).not.toHaveProperty("authorization");
    expect(run.webhookContext?.headers).not.toHaveProperty("proxy-authorization");
    expect(run.webhookContext?.headers).not.toHaveProperty("cookie");

    await app.close();
  });

  it("captures raw JSON bodies when content-type includes charset parameters", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });

    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );

    const rawBody = '{\n  "hello": "charset"\n}';
    const response = await app.inject({
      headers: {
        ...owner,
        "content-type": "application/json; charset=utf-8",
        "stripe-signature": "t=123,v1=charset",
      },
      method: "POST",
      payload: rawBody,
      url: "/hello",
    });

    expect(response.statusCode).toBe(200);
    const { runId } = response.json() as { runId: string };
    const run = await platform.getPlatformRun(runId);

    expect(run.payload).toEqual({ hello: "charset" });
    expect(run.webhookContext).toMatchObject({
      headers: {
        "content-type": "application/json; charset=utf-8",
        "stripe-signature": "t=123,v1=charset",
      },
      rawBodyBase64: Buffer.from(rawBody).toString("base64"),
      rawBodyByteLength: Buffer.byteLength(rawBody),
    });

    await app.close();
  });

  // A person's manual run skips the signature check, so code must be able to tell it from a
  // verified delivery: it is a manual run and carries none of the caller's headers.
  it("records a manual run of a signed webhook as manual, without the caller's headers", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-api-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });
    await platform.upsertSecret("WEBHOOK_SIGNING_SECRET", "secret", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    await deployFixture(
      app,
      path.join(repoRoot, "packages/runtime/test-fixtures/webhook-signature"),
      {},
      { headers: owner },
    );

    const manual = await app.inject({
      headers: { ...owner, "content-type": "application/json", "x-swizzle-signature": "sha256=0" },
      method: "POST",
      payload: '{"event":"invoice.paid"}',
      url: "/automations/webhook-signature/runs",
    });

    expect(manual.statusCode).toBe(200);
    const run = await platform.getPlatformRun((manual.json() as { runId: string }).runId);
    expect(run).toMatchObject({
      payload: { event: "invoice.paid" },
      triggerType: "manual",
      webhookContext: null,
    });
  });

  it("rejects bad platform webhook signatures before creating runs", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });

    await platform.upsertSecret("WEBHOOK_SIGNING_SECRET", "secret", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    await deployFixture(
      app,
      path.join(repoRoot, "packages/runtime/test-fixtures/webhook-signature"),
      {},
      { headers: owner },
    );

    const rejected = await app.inject({
      headers: {
        ...owner,
        "content-type": "application/json",
        "x-swizzle-signature": "sha256=bad",
      },
      method: "POST",
      payload: '{"event":"invoice.created"}',
      url: "/signed-webhook",
    });

    // A wrong signature on the public ingress collapses to the same opaque 404 as an
    // unknown path — a caller without the secret cannot confirm the endpoint exists.
    // The true reason (signature-mismatch) is still recorded in the trigger audit.
    expect(rejected.statusCode).toBe(404);
    expect(rejected.json()).toMatchObject({
      code: "WEBHOOK_NOT_AVAILABLE",
      error: "WEBHOOK_NOT_AVAILABLE",
    });
    expect(JSON.stringify(rejected.json())).not.toContain("SIGNATURE");

    const rawBody = '{\n  "event": "invoice.created"\n}';
    const signature = createHmac("sha256", "secret").update(rawBody).digest("hex");
    const accepted = await app.inject({
      headers: {
        ...owner,
        "content-type": "application/json",
        "x-swizzle-signature": `sha256=${signature}`,
      },
      method: "POST",
      payload: rawBody,
      url: "/signed-webhook",
    });

    expect(accepted.statusCode).toBe(200);
    const { runId } = accepted.json() as { runId: string };
    const run = await platform.getPlatformRun(runId);
    expect(run.payload).toEqual({ event: "invoice.created" });
    expect(run.webhookContext).toMatchObject({
      headers: {
        "x-swizzle-signature": `sha256=${signature}`,
      },
      rawBodyBase64: Buffer.from(rawBody).toString("base64"),
    });

    await app.close();
  });

  it("allows remote webhook ingress without a bearer token while gating operator routes", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);

    const apiTokenStore = testApiTokenStore();
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const people = testPeople();
    const app = await buildTestServer({ apiTokenStore, auth: people.auth, platform });

    const localOperator = await people.bearer(apiTokenStore, "ada@example.com", "owner");
    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      {
        headers: { authorization: localOperator.authorization },
      },
    );

    const remoteHeaders = {
      "x-forwarded-for": "203.0.113.45",
      host: "api.swizzle.example.com",
    };

    // An operator route from the same remote origin still requires a token.
    const gatedOperator = await app.inject({
      method: "GET",
      url: "/secrets",
      headers: remoteHeaders,
      remoteAddress: "203.0.113.45",
    });
    expect(gatedOperator.statusCode).toBe(401);
    expect(gatedOperator.json()).toMatchObject({ error: "UNAUTHORIZED" });

    // The declared webhook path is reachable from the public internet without any
    // Swizzle token — external callers (Stripe, GitHub, ...) never have one.
    const webhook = await app.inject({
      method: "POST",
      url: "/hello",
      payload: { hello: "world" },
      headers: remoteHeaders,
      remoteAddress: "203.0.113.45",
    });
    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toMatchObject({ status: "queued" });
    // An unknown webhook path is a "no such webhook" failure, not an auth failure:
    // proves the request cleared the auth gate and reached the trigger resolver.
    const unknown = await app.inject({
      method: "POST",
      url: "/no-such-hook",
      payload: {},
      headers: remoteHeaders,
      remoteAddress: "203.0.113.45",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "WEBHOOK_NOT_AVAILABLE" });

    await app.close();
  });

  it("rate-limits webhook ingress before trigger lookup or run creation", async () => {
    vi.stubEnv("SWIZZLE_WEBHOOK_INGRESS_RATE_LIMIT", "2/min");
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const apiTokenStore = testApiTokenStore();
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const people = testPeople();
    const app = await buildTestServer({ apiTokenStore, auth: people.auth, platform });

    const operator = await people.bearer(apiTokenStore, "ada@example.com", "owner");
    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      {
        headers: { authorization: operator.authorization },
      },
    );

    const remoteRequest = {
      headers: {
        "x-forwarded-for": "203.0.113.45",
        host: "api.swizzle.example.com",
      },
      remoteAddress: "203.0.113.45",
    };

    const first = await app.inject({
      method: "POST",
      url: "/no-such-hook",
      payload: {},
      ...remoteRequest,
    });
    expect(first.statusCode).toBe(404);
    expect(first.json()).toEqual({
      code: "WEBHOOK_NOT_AVAILABLE",
      error: "WEBHOOK_NOT_AVAILABLE",
      message: "No webhook is available for this path.",
    });

    const second = await app.inject({
      method: "POST",
      url: "/no-such-hook",
      payload: {},
      ...remoteRequest,
    });
    expect(second.statusCode).toBe(404);

    const third = await app.inject({
      method: "POST",
      url: "/no-such-hook",
      payload: {},
      ...remoteRequest,
    });
    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
    expect(third.json()).toMatchObject({
      error: "WEBHOOK_RATE_LIMITED",
      details: {
        currentCount: 2,
        limit: 2,
      },
    });

    // The budget is per-client, not per-path: the same client hitting a DIFFERENT
    // (real) path is still throttled, so scanning many paths cannot bypass the limit.
    const sameClientOtherPath = await app.inject({
      method: "POST",
      url: "/hello",
      payload: { hello: "world" },
      ...remoteRequest,
    });
    expect(sameClientOtherPath.statusCode).toBe(429);

    // A different client has an independent budget.
    const otherClient = await app.inject({
      method: "POST",
      url: "/hello",
      payload: { hello: "world" },
      headers: { host: "api.swizzle.example.com" },
      remoteAddress: "198.51.100.7",
    });
    expect(otherClient.statusCode).toBe(200);
    expect(otherClient.json()).toMatchObject({ status: "queued" });

    await app.close();
  });

  it("spends the same client budget on unknown environments and unknown paths", async () => {
    vi.stubEnv("SWIZZLE_WEBHOOK_INGRESS_RATE_LIMIT", "2/min");
    const stateDirectory = await temporaryDirectory("swizzle-api-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });
    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );
    const post = async (url: string) =>
      await app.inject({
        headers: owner,
        method: "POST",
        payload: {},
        remoteAddress: "203.0.113.45",
        url,
      });

    try {
      const unknownEnvironment = await post("/hello?environment=made-up");
      const unknownPath = await post("/no-such-hook");
      for (const response of [unknownEnvironment, unknownPath]) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          code: "WEBHOOK_NOT_AVAILABLE",
          error: "WEBHOOK_NOT_AVAILABLE",
          message: "No webhook is available for this path.",
        });
      }

      for (const url of ["/hello", "/hello?environment=another-made-up", "/no-such-hook"]) {
        const limited = await post(url);
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toMatchObject({
          error: "WEBHOOK_RATE_LIMITED",
          details: { currentCount: 2, limit: 2 },
        });
      }

      const otherClient = await app.inject({
        headers: owner,
        method: "POST",
        payload: {},
        remoteAddress: "198.51.100.7",
        url: "/hello",
      });
      expect(otherClient.statusCode).toBe(200);
      expect(otherClient.json()).toMatchObject({ status: "queued" });
    } finally {
      await app.close();
    }
  });

  it("answers successive unknown environments without waiting for a refresh timer", async () => {
    vi.stubEnv("SWIZZLE_WEBHOOK_INGRESS_RATE_LIMIT", "10/min");
    const app = await buildTestServer({ platform: await testPlatform() });
    await app.ready();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const statuses: number[] = [];
    const requests = (async () => {
      for (let index = 0; index < 3; index += 1) {
        const response = await app.inject({
          headers: owner,
          method: "POST",
          payload: {},
          url: `/hello?environment=made-up-${index}`,
        });
        statuses.push(response.statusCode);
      }
    })();

    try {
      // Drain HTTP injection callbacks without reaching a one-second refresh.
      await requests;
      expect([...statuses]).toEqual([404, 404, 404]);
    } finally {
      try {
        await vi.runAllTimersAsync();
        await requests;
      } finally {
        vi.useRealTimers();
        await app.close();
      }
    }
  });

  it("fails fast on invalid webhook ingress rate-limit configuration", async () => {
    vi.stubEnv("SWIZZLE_WEBHOOK_INGRESS_RATE_LIMIT", "many");

    await expect(buildTestServer({ platform: await testPlatform() })).rejects.toThrow(
      'Invalid rate limit format for "SWIZZLE_WEBHOOK_INGRESS_RATE_LIMIT"',
    );
  });
});
