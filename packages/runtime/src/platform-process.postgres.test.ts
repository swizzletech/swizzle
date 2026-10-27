import { rm, writeFile } from "node:fs/promises";

import path from "node:path";

import { DEFAULT_PROJECT_ID } from "@swizzle/db";

import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { testDatabase } from "../../../test/postgres.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory, waitFor } from "../../../test/support.js";

import { createAutomationFixture, packageRoot, repoRoot } from "../test/platform-harness.js";

describe("platform process", () => {
  it("surfaces secret health on deployments and injects only declared secrets into platform runs", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    const automationDirectory = path.join(packageRoot, "test-fixtures/platform-env-snapshot");
    await expect(
      platform.deployAutomationToPlatform({ automationDirectory, environment: "local" }),
    ).rejects.toMatchObject({
      code: "PLATFORM_REQUIRED_SECRETS_MISSING",
      details: { missingSecrets: ["DECLARED_SECRET"] },
    });

    const storedSecret = await platform.upsertSecret("DECLARED_SECRET", "from-secret-store", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    expect(storedSecret.secretVersion).toBe(1);

    await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });
    const deployment = await platform.getAutomationDeployment("platform-env-snapshot", "local");
    expect(deployment.secretHealth).toEqual([
      expect.objectContaining({
        name: "DECLARED_SECRET",
        secretVersion: 1,
        state: "bound",
      }),
    ]);

    const queuedRun = await platform.startManualRun({
      environment: "local",
      automationName: "platform-env-snapshot",
      payload: { via: "secret-store" },
    });

    const processedRun = await platform.processNextPlatformRun({
      environment: {
        DATABASE_URL: "postgresql://should-not-leak",
        PATH: process.env.PATH,
        SWIZZLE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      },
    });

    expect(processedRun?.status).toBe("succeeded");
    // The run read its secret; the platform stores the printed value redacted.
    expect(processedRun?.result).toMatchObject({
      database_url: null,
      declared_secret: "[REDACTED]",
      encryption_key: null,
      payload: { via: "secret-store" },
      trigger_type: "manual",
    });

    const persistedRun = await platform.getPlatformRun(queuedRun.runId);
    expect(persistedRun.executions[0]?.secretUsages).toEqual([
      expect.objectContaining({
        secretName: "DECLARED_SECRET",
        secretVersion: 1,
      }),
    ]);
  });

  it("tells a platform run the environment its deployment belongs to", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: "console.log(JSON.stringify({ environment: process.env.SWIZZLE_ENV }));\n",
      name: "environment-echo",
      triggerLines: ["  type: webhook", "  path: /environment-echo"],
    });
    await platform.deployAutomationToPlatform({ automationDirectory, environment: "production" });

    await platform.startManualRun({
      automationName: "environment-echo",
      environment: "production",
    });
    const processedRun = await platform.processNextPlatformRun();

    expect(processedRun?.environment).toBe("production");
    expect(processedRun?.result).toEqual({ environment: "production" });
  });

  it("authorizes a connection and injects only its access token into platform runs", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    // A version deploys once its connection exists, and runs once the connection is active.
    const automationDirectory = path.join(
      packageRoot,
      "test-fixtures/platform-connection-snapshot",
    );
    await expect(
      platform.deployAutomationToPlatform({ automationDirectory, environment: "local" }),
    ).rejects.toMatchObject({ code: "PLATFORM_REQUIRED_CONNECTIONS_MISSING" });

    // Authorize the connection: begin with the client credentials inline, then
    // complete the callback with a mocked provider token response.
    const authorization = await platform.beginConnectionAuthorization({
      place: { environment: "local", projectId: DEFAULT_PROJECT_ID },
      clientId: "client-id",
      clientSecret: "client-secret",
      name: "test-google",
      provider: "google",
      publicUrl: "https://api.example.com",
      reauthorizes: null,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });
    await expect(
      platform.startManualRun({
        environment: "local",
        automationName: "platform-connection-snapshot",
        payload: { via: "unauthorized" },
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_REQUIRED_CONNECTIONS_MISSING" });
    const state = new URL(authorization.authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "live-access-token",
          expires_in: 3600,
          refresh_token: "live-refresh-token",
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );
    const callback = await platform.completeConnectionCallback({
      code: "auth-code",
      providerFromPath: "google",
      state: state ?? "",
    });
    expect(callback.ok).toBe(true);

    const queuedRun = await platform.startManualRun({
      environment: "local",
      automationName: "platform-connection-snapshot",
      payload: { via: "connection" },
    });

    const processedRun = await platform.processNextPlatformRun({
      environment: {
        PATH: process.env.PATH,
        SWIZZLE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      },
    });

    expect(processedRun?.status).toBe("succeeded");
    // The short-lived access token reaches user code, stored redacted; the refresh token does not.
    expect(processedRun?.result).toMatchObject({
      connection_token: "[REDACTED]",
      leaked_refresh_token: null,
      payload: { via: "connection" },
      connection_expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    const persistedRun = await platform.getPlatformRun(queuedRun.runId);
    expect(persistedRun.executions[0]?.connectionUsages).toEqual([
      expect.objectContaining({
        connectionName: "test-google",
        provider: "google",
        tokenVersion: 1,
      }),
    ]);
  });

  it("redacts the run's secret and connection token from everything it prints", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    await platform.upsertSecret("API_KEY", "declared-secret-value", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    const authorization = await platform.beginConnectionAuthorization({
      place: { environment: "local", projectId: DEFAULT_PROJECT_ID },
      clientId: "client-id",
      clientSecret: "client-secret",
      name: "test-google",
      provider: "google",
      publicUrl: "https://api.example.com",
      reauthorizes: null,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "connection-access-token", expires_in: 3600 }), {
        status: 200,
      }),
    );
    await platform.completeConnectionCallback({
      code: "auth-code",
      providerFromPath: "google",
      state: new URL(authorization.authorizationUrl).searchParams.get("state") ?? "",
    });
    const automationDirectory = await createAutomationFixture({
      configLines: [
        "secrets: [API_KEY]",
        "connections: [test-google]",
        "api_check: { mode: passive }",
      ],
      mainJs: [
        "const secret = process.env.API_KEY, token = process.env.SWIZZLE_CONNECTION_TEST_GOOGLE;",
        "console.error('token ' + token);",
        // Two writes apart in time reach the platform as two chunks, splitting the value.
        "process.stderr.write('secret ' + secret.slice(0, 9));",
        "setTimeout(() => {",
        "  process.stderr.write(secret.slice(9) + '\\n');",
        "  console.log(JSON.stringify({ secret, nested: { token } }));",
        "}, 100);",
        "",
      ].join("\n"),
      name: "prints-credentials",
      triggerLines: ["  type: webhook", "  path: /prints-credentials"],
    });
    await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });
    const queued = await platform.startManualRun({
      automationName: "prints-credentials",
      environment: "local",
    });

    const streamed: string[] = [];
    await platform.processNextPlatformRun({
      environment: { PATH: process.env.PATH, SWIZZLE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
      onStderrChunk: (chunk) => streamed.push(chunk),
    });
    const run = await platform.getPlatformRun(queued.runId);

    expect(run.status).toBe("succeeded");
    expect(run.result).toEqual({ nested: { token: "[REDACTED]" }, secret: "[REDACTED]" });
    expect(run.stderr).toBe("token [REDACTED]\nsecret [REDACTED]\n");
    expect(streamed.join("")).toBe("token [REDACTED]\nsecret [REDACTED]\n");
    expect(JSON.stringify(run)).not.toMatch(/declared-secret|connection-access/u);
  });

  it("rejects webhook runs before enqueue once a bound secret is deleted", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const place = { environment: "local", projectId: DEFAULT_PROJECT_ID };
    const secret = await platform.upsertSecret("DECLARED_SECRET", "value", place);
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(packageRoot, "test-fixtures/platform-env-snapshot"),
    });
    await platform.deleteSecret(secret.id);

    await expect(
      platform.triggerWebhookByPath({
        environment: "local",
        path: "/platform-env",
        payload: { via: "missing-secret" },
      }),
    ).rejects.toMatchObject({
      code: "PLATFORM_REQUIRED_SECRETS_MISSING",
      details: {
        missingSecrets: ["DECLARED_SECRET"],
      },
    });

    expect(await platform.processNextPlatformRun()).toBeNull();

    const auditEvents = await platform.listAutomationTriggerAuditEvents(
      "platform-env-snapshot",
      "local",
    );
    expect(auditEvents.map((event) => event.change)).toEqual([
      expect.objectContaining({
        eventType: "webhook_rejected",
        metadata: expect.objectContaining({
          missingSecrets: ["DECLARED_SECRET"],
          reason: "missing-secrets",
        }),
      }),
    ]);
  });

  it("pauses and resumes triggers without losing auditability", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
    });

    const pausedTrigger = await platform.pauseAutomationTrigger("hello-webhook", "local");
    expect(pausedTrigger.status).toBe("paused");

    await expect(
      platform.triggerWebhookByPath({
        environment: "local",
        path: "/hello",
        payload: { via: "paused-trigger" },
      }),
    ).rejects.toMatchObject({
      code: "TRIGGER_PAUSED",
    });

    const manualWhilePaused = await platform.startManualRun({
      environment: "local",
      automationName: "hello-webhook",
      payload: { via: "manual-paused-trigger" },
    });
    expect(manualWhilePaused.status).toBe("queued");
    expect(manualWhilePaused.warning).toContain("manual run executed anyway");

    await platform.processNextPlatformRun();

    const resumedTrigger = await platform.resumeAutomationTrigger("hello-webhook", "local");
    expect(resumedTrigger.status).toBe("active");

    const resumedRun = await platform.startManualRun({
      environment: "local",
      automationName: "hello-webhook",
      payload: { via: "resumed-trigger" },
    });
    expect(resumedRun.status).toBe("queued");

    await platform.processNextPlatformRun();

    const auditEvents = await platform.listAutomationTriggerAuditEvents("hello-webhook", "local");
    expect(auditEvents.map((event) => event.change.eventType)).toEqual([
      "trigger_paused",
      "webhook_rejected",
      "trigger_resumed",
    ]);
  });

  it("keeps the API contacts and rate-limit usage of an attempt a failed state event ended", async () => {
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-platform-"), "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const log = (event) => process.stderr.write(JSON.stringify(event) + '\\n');",
        "log({ type: 'rate_limit_usage', group: 'api', count: 3 });",
        "log({ type: 'api_contact', host: 'api.example.com', status: 200 });",
        "log({ type: 'state_set', key: 'cursor' });",
        "console.log('{}');",
        "",
      ].join("\n"),
      name: "signals-on-failure",
      triggerLines: ["  type: webhook", "  path: /signals-on-failure"],
    });
    await platform.deployAutomationToPlatform({ environment: "local", automationDirectory });
    const { runId } = await platform.startManualRun({
      environment: "local",
      automationName: "signals-on-failure",
      payload: {},
    });

    await platform.processNextPlatformRun();

    expect((await platform.getPlatformRun(runId)).executions[0]).toMatchObject({
      errorCode: "AUTOMATION_STATE_LIMIT_EXCEEDED",
      metadata: { rateLimitUsage: { api: 3 } },
    });
    expect(
      (await testDatabase().pool.query("SELECT host, last_status FROM api_contacts")).rows,
    ).toEqual([{ host: "api.example.com", last_status: 200 }]);
  });

  it("persists automation state events in order and provides a cleaned per-run scratch dir", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const state = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STATE_FILE, 'utf8'));",
        "process.stderr.write(JSON.stringify({ type: 'state_set', key: 'cursor', value: 'next-1' }) + '\\n');",
        "process.stderr.write(JSON.stringify({ type: 'state_set', key: 'temp', value: 'delete-me' }) + '\\n');",
        "process.stderr.write(JSON.stringify({ type: 'state_delete', key: 'temp' }) + '\\n');",
        "process.stderr.write(JSON.stringify({ type: 'rate_limit_usage', group: 'api', count: 3 }) + '\\n');",
        "console.log(JSON.stringify({",
        "  previousCursor: state.cursor ?? null,",
        "  cwd: process.cwd(),",
        "  tmp: process.env.SWIZZLE_RUN_TMP,",
        "  sameScratch: fs.realpathSync(process.cwd()) === fs.realpathSync(process.env.SWIZZLE_RUN_TMP),",
        "  stateFileExists: fs.existsSync(process.env.SWIZZLE_STATE_FILE),",
        "}));",
        "",
      ].join("\n"),
      name: "state-scratch",
      triggerLines: ["  type: webhook", "  path: /state-scratch"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "86a17259-955e-571f-a0fe-e70b0db7be71",
    });

    const firstRun = await platform.startManualRun({
      environment: "local",
      automationName: "state-scratch",
      payload: {},
    });
    const firstProcessed = await platform.processNextPlatformRun();
    expect(firstProcessed?.status).toBe("succeeded");
    expect(firstProcessed?.result).toMatchObject({
      previousCursor: null,
      sameScratch: true,
      stateFileExists: true,
      tmp: expect.any(String),
    });

    const scratchDir = (firstProcessed?.result as { tmp: string } | undefined)?.tmp ?? "";
    await expect(rm(scratchDir, { recursive: true })).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      platform.listAutomationState({ environment: "local", automationName: "state-scratch" }),
    ).resolves.toEqual([expect.objectContaining({ key: "cursor", value: "next-1" })]);
    const persistedFirstRun = await platform.getPlatformRun(firstRun.runId);
    expect(persistedFirstRun.executions[0]?.metadata).toMatchObject({
      rateLimitUsage: { api: 3 },
    });

    await platform.startManualRun({
      environment: "local",
      automationName: "state-scratch",
      payload: {},
    });
    const secondProcessed = await platform.processNextPlatformRun();
    expect(secondProcessed?.status).toBe("succeeded");
    expect(secondProcessed?.result).toMatchObject({
      previousCursor: "next-1",
    });
  });

  it("appends run output before the attempt reaches a terminal state", async ({ signal }) => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    // The child holds after phase-one until the test creates the gate file, so the
    // mid-run read never races the child's exit.
    const gatePath = path.join(stateDirectory, "gate");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "process.stderr.write('phase-one\\n');",
        "const timer = setInterval(() => {",
        `  if (!fs.existsSync(${JSON.stringify(gatePath)})) return;`,
        "  clearInterval(timer);",
        "  process.stderr.write('phase-two\\n');",
        "  console.log(JSON.stringify({ ok: true }));",
        "}, 10);",
        "",
      ].join("\n"),
      name: "streaming-logs",
      triggerLines: ["  type: webhook", "  path: /streaming-logs"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "f6016f47-6121-5f16-8676-cac6d74206dc",
    });
    const queuedRun = await platform.startManualRun({
      environment: "local",
      automationName: "streaming-logs",
      payload: {},
    });

    let settled = false;
    const processing = platform.processNextPlatformRun().finally(() => {
      settled = true;
    });
    // Settled in finally; this handler keeps an early rejection from going unhandled while the test polls.
    processing.catch(() => undefined);
    try {
      await waitFor(
        signal,
        async () =>
          settled || (await platform.getPlatformRun(queuedRun.runId)).stderr.includes("phase-one"),
      );

      const midRun = await platform.getPlatformRun(queuedRun.runId);
      expect(midRun.status).toBe("running");
      expect(midRun.stderr).not.toContain("phase-two");
    } finally {
      // Released and settled on every path, so a failed or timed-out test never leaves the
      // child running while its temporary directories are removed.
      await writeFile(gatePath, "");
      await Promise.allSettled([processing]);
    }
    expect((await processing)?.status).toBe("succeeded");
    expect((await platform.getPlatformRun(queuedRun.runId)).stderr).toContain("phase-two");
  });
});
