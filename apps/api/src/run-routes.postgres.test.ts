import path from "node:path";

import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

import { createAutomationFixture, deployFixture } from "../test/automations.js";

import { ownerHeaders } from "../test/people.js";

import { buildTestServer } from "../test/server-harness.js";

import type { DashboardDataProvider } from "./dashboard.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

const appRoot = path.resolve(sourceRoot, "..");

const repoRoot = path.resolve(appRoot, "../..");

let owner: { readonly authorization: string };

beforeEach(async () => {
  owner = await ownerHeaders();
});

const emptyRunFilters = { automationSlug: null, limit: 50, statuses: [], triggerType: null };

// A read model with no data; each test overrides only the calls it observes.
function createDashboardStub(overrides: Partial<DashboardDataProvider>): DashboardDataProvider {
  const unused = async (): Promise<never> => {
    throw new Error("Not used by this test.");
  };
  return {
    close: async () => {},
    getAutomationDetail: async () => null,
    getAutomationReadme: async () => null,
    getAutomationSource: async () => null,
    getMermaidDiagram: async () => null,
    getOperabilitySummary: unused,
    getStepReach: async () => null,
    getOverview: unused,
    getOperationsSummary: unused,
    listAutomations: async () => [],
    listRuns: async () => ({ environment: "local", filters: emptyRunFilters, runs: [] }),
    listRunSteps: async () => [],
    ...overrides,
  };
}

describe("run routes", () => {
  it("returns run logs with an incremental cursor", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "process.stderr.write('debug one\\n');",
        "process.stderr.write('debug two\\n');",
        "console.log(JSON.stringify({ ok: true }));",
        "",
      ].join("\n"),
      name: "api-log-cursor",
      path: "/api-log-cursor",
    });

    await deployFixture(app, automationDirectory, {}, { headers: owner });
    const triggerResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: {},
      url: "/api-log-cursor",
    });
    const runId = triggerResponse.json().runId as string;
    await platform.processNextPlatformRun();

    const firstLogs = await app.inject({
      headers: owner,
      method: "GET",
      url: `/runs/${runId}/logs`,
    });
    expect(firstLogs.statusCode).toBe(200);
    const firstBody = firstLogs.json();
    expect(firstBody).toMatchObject({
      chunks: [
        expect.objectContaining({ stream: "stdout" }),
        expect.objectContaining({ stream: "stderr" }),
      ],
      status: "succeeded",
      terminal: true,
    });

    const secondLogs = await app.inject({
      headers: owner,
      method: "GET",
      url: `/runs/${runId}/logs?after=${encodeURIComponent(firstBody.cursor)}`,
    });
    expect(secondLogs.statusCode).toBe(200);
    expect(secondLogs.json()).toMatchObject({
      chunks: [],
      cursor: firstBody.cursor,
      terminal: true,
    });

    // The live log stream carries the headers every other answer carries.
    const stream = await app.inject({
      headers: owner,
      method: "GET",
      url: `/runs/${runId}/logs/stream`,
    });
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    expect(stream.payload).toContain("event: end");
    expect(stream.headers).toMatchObject({
      "cache-control": "no-store, no-transform",
      "content-security-policy":
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'",
      "cross-origin-opener-policy": "same-origin",
      "permissions-policy": "camera=(), geolocation=(), microphone=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });

    // A cross-origin client in SWIZZLE_CORS_ORIGINS may read the stream; any other origin may not.
    vi.stubEnv("SWIZZLE_CORS_ORIGINS", "https://tools.example.com");
    const streamFrom = (origin: string) =>
      app.inject({
        headers: { ...owner, origin },
        method: "GET",
        url: `/runs/${runId}/logs/stream`,
      });
    const listed = await streamFrom("https://tools.example.com");
    expect(listed.payload).toContain("event: end");
    expect(listed.headers).toMatchObject({
      "access-control-allow-credentials": "true",
      "access-control-allow-origin": "https://tools.example.com",
    });
    const unlisted = await streamFrom("https://elsewhere.example.com");
    expect(unlisted.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("sends the live log stream's stored events while Valkey is unreachable", async () => {
    vi.stubEnv("VALKEY_URL", "redis://127.0.0.1:1");
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
    const trigger = await app.inject({
      headers: owner,
      method: "POST",
      payload: {},
      url: "/hello",
    });
    const runId = trigger.json().runId as string;
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const client = new AbortController();
    const timer = setTimeout(() => client.abort(), 2_000);
    try {
      const response = await fetch(`${address}/runs/${runId}/logs/stream`, {
        headers: owner,
        signal: client.signal,
      });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      if (response.body === null) throw new Error("The log stream has no body.");
      // Split delivery so the assertion cannot depend on the server's write boundaries.
      const reader = response.body
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              for (let offset = 0; offset < chunk.length; offset += 7) {
                controller.enqueue(chunk.subarray(offset, offset + 7));
              }
            },
          }),
        )
        .getReader();
      const decoder = new TextDecoder();
      let firstEvent = "";
      while (!firstEvent.includes("\n\n")) {
        const { done, value } = await reader.read();
        if (done) throw new Error("The log stream ended before its first event.");
        firstEvent += decoder.decode(value, { stream: true });
      }
      expect(firstEvent.split("\n\n")[0]).toContain(
        'event: status\ndata: {"status":"queued","terminal":false}',
      );
    } finally {
      clearTimeout(timer);
      client.abort();
      await app.close();
    }
  });

  it("exposes automation state list, get, set, and delete endpoints", async () => {
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

    const setResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: { key: "cursor", value: { id: 123 } },
      url: "/automations/hello-webhook/state",
    });
    expect(setResponse.statusCode).toBe(200);
    expect(setResponse.json()).toMatchObject({
      state: expect.objectContaining({ key: "cursor", value: { id: 123 } }),
    });

    const getResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/hello-webhook/state?key=cursor",
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      state: expect.objectContaining({ key: "cursor", value: { id: 123 } }),
    });

    const listResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/hello-webhook/state",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().state).toEqual([
      expect.objectContaining({ key: "cursor", value: { id: 123 } }),
    ]);

    const deleteResponse = await app.inject({
      headers: owner,
      method: "DELETE",
      url: "/automations/hello-webhook/state?key=cursor",
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ deleted: true, key: "cursor" });

    await app.close();
  });

  it("exposes per-automation timeout grant set, get, list, and delete endpoints", async () => {
    const grantDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(grantDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });
    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );

    const emptyGet = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/hello-webhook/timeout-grant",
    });
    expect(emptyGet.statusCode).toBe(200);
    expect(emptyGet.json()).toMatchObject({ grant: null });

    const setResponse = await app.inject({
      headers: owner,
      method: "PUT",
      payload: { maxTimeoutMs: 10_800_000, note: "nightly batch" },
      url: "/automations/hello-webhook/timeout-grant",
    });
    expect(setResponse.statusCode).toBe(200);
    expect(setResponse.json()).toMatchObject({
      grant: expect.objectContaining({
        automationSlug: "hello-webhook",
        maxTimeoutMs: 10_800_000,
        note: "nightly batch",
      }),
    });

    const listResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/timeout-grants",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().grants).toEqual([
      expect.objectContaining({ automationSlug: "hello-webhook", maxTimeoutMs: 10_800_000 }),
    ]);

    // Invalid duration is a 400.
    const invalid = await app.inject({
      headers: owner,
      method: "PUT",
      payload: { maxTimeoutMs: -5 },
      url: "/automations/hello-webhook/timeout-grant",
    });
    expect(invalid.statusCode).toBe(400);

    // Unknown automation is a 404.
    const unknown = await app.inject({
      headers: owner,
      method: "PUT",
      payload: { maxTimeoutMs: 10_800_000 },
      url: "/automations/does-not-exist/timeout-grant",
    });
    expect(unknown.statusCode).toBe(404);

    const deleteResponse = await app.inject({
      headers: owner,
      method: "DELETE",
      url: "/automations/hello-webhook/timeout-grant",
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ deleted: true });

    // Deleting an absent grant is a 404.
    const deleteAgain = await app.inject({
      headers: owner,
      method: "DELETE",
      url: "/automations/hello-webhook/timeout-grant",
    });
    expect(deleteAgain.statusCode).toBe(404);
    expect(deleteAgain.json()).toMatchObject({ error: "TIMEOUT_GRANT_NOT_FOUND" });

    await app.close();
  });

  it("maps dashboard run filters onto the read model and missing records to 404", async () => {
    const runQueries: unknown[] = [];
    const app = await buildTestServer({
      dashboard: createDashboardStub({
        listRuns: async (query) => {
          runQueries.push(query);
          return { environment: "local", filters: emptyRunFilters, runs: [] };
        },
      }),
      platform: await testPlatform(),
    });

    const runs = await app.inject({
      headers: owner,
      method: "GET",
      url: "/dashboard/runs?automation=hello-webhook&status=failed,dead-lettered&limit=5&topLevelOnly=true",
    });
    expect(runs.statusCode).toBe(200);
    expect(runQueries).toEqual([
      {
        automationSlug: "hello-webhook",
        environment: "local",
        limit: 5,
        scope: { all: true },
        statuses: ["failed", "dead-lettered"],
        topLevelOnly: true,
      },
    ]);
    const unknownStatus = await app.inject({
      headers: owner,
      method: "GET",
      url: "/dashboard/runs?status=broken",
    });
    expect(unknownStatus.statusCode).toBe(400);

    const missingRun = await app.inject({
      headers: owner,
      method: "GET",
      url: "/dashboard/runs/00000000-0000-4000-8000-000000000000",
    });
    expect(missingRun.statusCode).toBe(404);
    expect(missingRun.json()).toMatchObject({ error: "RUN_NOT_FOUND" });

    const missingReadme = await app.inject({
      headers: owner,
      method: "GET",
      url: "/dashboard/automations/missing/readme",
    });
    expect(missingReadme.statusCode).toBe(404);
    expect(missingReadme.json()).toMatchObject({ error: "AUTOMATION_NOT_FOUND" });

    await app.close();
  });

  it("cancels queued runs and reports alreadyTerminal for terminal runs", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);

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

    const trigger = await app.inject({
      headers: owner,
      method: "POST",
      payload: { hello: "world" },
      url: "/hello",
    });
    expect(trigger.statusCode).toBe(200);
    const { runId } = trigger.json() as { runId: string };

    const cancelled = await app.inject({
      headers: owner,
      method: "POST",
      url: `/runs/${runId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    const cancelBody = cancelled.json() as {
      alreadyTerminal: boolean;
      run: { status: string; deadLetterReason: string | null };
    };
    expect(cancelBody.alreadyTerminal).toBe(false);
    expect(cancelBody.run.status).toBe("dead-lettered");
    expect(cancelBody.run.deadLetterReason).toBe("user-cancelled");

    const cancelAgain = await app.inject({
      headers: owner,
      method: "POST",
      url: `/runs/${runId}/cancel`,
    });
    expect(cancelAgain.statusCode).toBe(200);
    expect((cancelAgain.json() as { alreadyTerminal: boolean }).alreadyTerminal).toBe(true);

    await app.close();
  });
});
