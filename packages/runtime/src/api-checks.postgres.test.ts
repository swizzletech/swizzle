import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";
import { enqueueDueChecks } from "./api-checks.js";

import type { RunQueueProducer } from "./run-queue.js";

// An active API check end to end on the test platform: the deploy makes it due, the
// scheduler enqueues it, the worker runs check.js and writes the automation_checks record.

const CHECK_JS = (body: string) =>
  [
    "const log = (event) => process.stderr.write(JSON.stringify(event) + '\\n');",
    "log({ type: 'state_set', key: 'cursor', value: 'moved-by-check' });",
    "log({ type: 'api_contact', host: 'api.example.com', method: 'GET', path: '/v1/deals?token=' + process.env.API_KEY, status: 200, sunset: 'Thu, 31 Dec 2026 23:59:59 GMT', link: '<https://example.com/sunset>; rel=\"sunset\"' });",
    "process.stderr.write('using ' + process.env.API_KEY + '\\n');",
    body,
    "",
  ].join("\n");

async function deployCheckedAutomation(checkJs: string) {
  vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  const platform = await testPlatform({
    artifactsDirectory: path.join(await temporaryDirectory("swizzle-platform-"), "artifacts"),
  });
  const directory = await createAutomationFixture({
    configLines: ["secrets: [API_KEY]", "api_check:", "  mode: active", "  entrypoint: check.js"],
    name: "crm-export",
    triggerLines: ["  type: webhook", "  path: /crm-export"],
  });
  await writeFile(path.join(directory, "check.js"), checkJs, "utf8");
  await platform.upsertSecret("API_KEY", "secret-key-value", {
    environment: "local",
    projectId: DEFAULT_PROJECT_ID,
  });
  await platform.deployAutomationToPlatform({
    automationDirectory: directory,
    environment: "local",
  });

  const enqueued: Parameters<RunQueueProducer["enqueueCheck"]>[0][] = [];
  const queue = {
    enqueueCheck: async (input: Parameters<RunQueueProducer["enqueueCheck"]>[0]) => {
      enqueued.push(input);
    },
  } as RunQueueProducer;
  const due = await enqueueDueChecks({ environment: "local", queue, store: platform.store });
  const environment = { PATH: process.env.PATH, SWIZZLE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY };
  return { due, enqueued, environment, platform };
}

describe("API checks", () => {
  it("runs a deployed check as its own record: no run, no state, secrets redacted", async () => {
    const { due, enqueued, environment, platform } = await deployCheckedAutomation(
      CHECK_JS("console.log(JSON.stringify({ ok: true, checked: ['GET /v1/deals'] }));"),
    );
    const [check] = due;
    expect(enqueued).toEqual([
      {
        checkId: check?.checkId,
        dueAt: check?.nextCheckAt,
        queueName: "platform-runs--host-default",
      },
    ]);

    const recorded = await platform.processPlatformCheck(
      check?.checkId ?? "",
      check?.nextCheckAt ?? "",
      { environment },
    );

    expect(recorded).toMatchObject({
      consecutiveFailures: 0,
      lastExitCode: 0,
      lastGreenOutput: '{"ok":true,"checked":["GET /v1/deals"]}',
      lastGreenReport: { ok: true, checked: ["GET /v1/deals"], change: null },
      lastReport: { ok: true, checked: ["GET /v1/deals"], change: null },
      lastWarning:
        "The check printed state or step events; checks hold no state, so they were ignored.",
      status: "green",
    });
    // The check records which secret version it received, as a run attempt does, never the value.
    expect(recorded?.lastSecretUsages).toEqual([
      {
        algorithm: "aes-256-gcm",
        environment: "local",
        injectedAt: expect.any(String),
        keyVersion: expect.any(String),
        secretName: "API_KEY",
        secretVersion: 1,
      },
    ]);
    expect(recorded?.lastStderrTail).toContain("using [REDACTED]");
    expect(recorded?.lastStderrTail).not.toContain("secret-key-value");
    // No run was queued or recorded for the automation.
    expect(await platform.processNextPlatformRun()).toBeNull();
    expect(
      await platform.store.countActiveRunsForAutomation(check?.automationId ?? "", "local"),
    ).toBe(0);
    expect(
      await platform.store.listAutomationState({
        automationId: check?.automationId ?? "",
        environment: "local",
      }),
    ).toEqual([]);
    // The check recorded the API's sunset notice like a run would: a second sighting is not new.
    const sighting = {
      host: "api.example.com",
      lastContactAt: new Date().toISOString(),
      lastOkAt: null,
      lastStatus: 200,
      notice: {
        deprecatedAt: null,
        path: "/v1/deals",
        sunsetAt: "2026-12-31T23:59:59.000Z",
        url: null,
      },
    };
    expect(
      await platform.store.recordApiContacts({
        automationId: check?.automationId ?? "",
        contacts: [sighting],
        environment: "local",
      }),
    ).toEqual([]);

    // The same due time again is a duplicate job: it runs nothing.
    expect(
      await platform.processPlatformCheck(check?.checkId ?? "", check?.nextCheckAt ?? "", {
        environment,
      }),
    ).toBeNull();
  });

  it("records which connection token version a check received, as a run attempt does", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-platform-"), "artifacts"),
    });
    const directory = await createAutomationFixture({
      configLines: [
        "connections: [crm-google]",
        "api_check:",
        "  mode: active",
        "  entrypoint: check.js",
      ],
      name: "crm-export",
      triggerLines: ["  type: webhook", "  path: /crm-export"],
    });
    await writeFile(
      path.join(directory, "check.js"),
      "console.log(JSON.stringify({ ok: true, checked: [] }));\n",
      "utf8",
    );
    const authorization = await platform.beginConnectionAuthorization({
      place: { environment: "local", projectId: DEFAULT_PROJECT_ID },
      clientId: "client-id",
      clientSecret: "client-secret",
      name: "crm-google",
      provider: "google",
      publicUrl: "https://api.example.com",
      reauthorizes: null,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "live-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );
    await platform.completeConnectionCallback({
      code: "auth-code",
      providerFromPath: "google",
      state: new URL(authorization.authorizationUrl).searchParams.get("state") ?? "",
    });
    const [check] = await platform.store.listDueAutomationChecks(new Date().toISOString(), "local");

    const recorded = await platform.processPlatformCheck(
      check?.checkId ?? "",
      check?.nextCheckAt ?? "",
      { environment: { PATH: process.env.PATH, SWIZZLE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } },
    );

    expect(recorded?.status).toBe("green");
    expect(recorded?.lastConnectionUsages).toEqual([
      {
        connectionName: "crm-google",
        environment: "local",
        injectedAt: expect.any(String),
        provider: "google",
        tokenVersion: 1,
      },
    ]);
  });

  it("records exit 1 as drift at once, and other failures as undecided", async () => {
    const { due, environment, platform } = await deployCheckedAutomation(
      CHECK_JS(
        "console.error(JSON.stringify({ type: 'contract_changed', api: 'api.example.com', field: 'amount', expected: 'number', got: 'string' })); process.exit(1);",
      ),
    );
    const [check] = due;

    const drift = await platform.processPlatformCheck(
      check?.checkId ?? "",
      check?.nextCheckAt ?? "",
      { environment },
    );

    expect(drift).toMatchObject({
      consecutiveFailures: 1,
      lastExitCode: 1,
      lastReport: {
        ok: false,
        checked: [],
        change: { api: "api.example.com", field: "amount", expected: "number", got: "string" },
      },
      status: "drift",
    });
    expect(drift?.failingSince).not.toBeNull();
  });

  it("gives the check script payload {}, its own secrets, no state or step file and trigger type check", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-platform-"), "artifacts"),
    });
    // The webhook's schema requires a field the check's payload {} lacks, and the automation
    // declares a secret the check does not name and the environment no longer holds.
    const directory = await createAutomationFixture({
      configLines: [
        "secrets: [API_KEY, EXPORT_TOKEN]",
        "api_check:",
        "  mode: active",
        "  entrypoint: check.js",
        "  secrets: [API_KEY]",
      ],
      name: "crm-export",
      triggerLines: [
        "  type: webhook",
        "  path: /crm-export",
        "  payload_schema:",
        "    type: object",
        "    required: [dealId]",
      ],
    });
    await writeFile(
      path.join(directory, "check.js"),
      [
        "const payload = require('node:fs').readFileSync(0, 'utf8');",
        "console.log(JSON.stringify({ ok: true, checked: [], payload,",
        "  apiKey: process.env.API_KEY === 'secret-key-value',",
        "  stateFile: process.env.SWIZZLE_STATE_FILE ?? null,",
        "  stepsFile: process.env.SWIZZLE_STEPS_FILE ?? null,",
        "  trigger: process.env.SWIZZLE_TRIGGER_TYPE }));",
        "",
      ].join("\n"),
      "utf8",
    );
    const place = { environment: "local", projectId: DEFAULT_PROJECT_ID };
    await platform.upsertSecret("API_KEY", "secret-key-value", place);
    const exportToken = await platform.upsertSecret("EXPORT_TOKEN", "export-token-value", place);
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
    await platform.deleteSecret(exportToken.id);
    const [check] = await platform.store.listDueAutomationChecks(new Date().toISOString(), "local");

    const recorded = await platform.processPlatformCheck(
      check?.checkId ?? "",
      check?.nextCheckAt ?? "",
      { environment: { PATH: process.env.PATH, SWIZZLE_STATE_FILE: "/tmp/inherited-state.json" } },
    );

    expect(recorded?.status).toBe("green");
    expect(JSON.parse(recorded?.lastOutput ?? "null")).toEqual({
      apiKey: true,
      checked: [],
      ok: true,
      payload: "{}",
      stateFile: null,
      stepsFile: null,
      trigger: "check",
    });
  });

  it("redacts a secret that reaches the failure message, as a parser error quoting stdout", async () => {
    const { due, environment, platform } = await deployCheckedAutomation(
      CHECK_JS("console.log(process.env.API_KEY);"),
    );
    const [check] = due;

    const undecided = await platform.processPlatformCheck(
      check?.checkId ?? "",
      check?.nextCheckAt ?? "",
      { environment },
    );

    expect(undecided?.status).toBe("error");
    expect(undecided?.lastWarning).toContain('"[REDACTED]" is not valid JSON');
    expect(JSON.stringify(undecided)).not.toContain("secret-key-value");
  });
});
