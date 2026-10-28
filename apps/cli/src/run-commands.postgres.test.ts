import { mkdir, writeFile } from "node:fs/promises";

import { createServer } from "node:http";

import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { temporaryDirectory, waitFor } from "../../../test/support.js";

import {
  buildTestServer,
  createBufferIO,
  createDashboardStub,
  repoRoot,
  useCliTestEnvironment,
  withoutProfile,
} from "../test/cli-harness.js";

import { runCli } from "./main.js";

// Commands that talk to an API instance, run against a real in-process API server with PostgreSQL stores.
useCliTestEnvironment();

describe("run commands", () => {
  it("manages durable automation state through the API", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-cli-state-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
    });

    const app = await buildTestServer({
      dashboard: createDashboardStub("hello-webhook"),
      platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const state = async (...args: string[]) => {
        const io = createBufferIO();
        const exitCode = await runCli(
          ["state", ...args, "--json", "--api-url", address, "--exact"],
          io,
        );
        return { exitCode, output: JSON.parse(io.stdoutText) };
      };

      expect(await state("set", "hello-webhook", "cursor", '{"id":123}')).toMatchObject({
        exitCode: 0,
        output: { automation: "hello-webhook", key: "cursor", value: { id: 123 } },
      });
      expect(await state("get", "hello-webhook", "cursor")).toMatchObject({
        exitCode: 0,
        output: { key: "cursor", value: { id: 123 } },
      });
      expect((await state("list", "hello-webhook")).output.state).toEqual([
        { key: "cursor", value: { id: 123 }, updatedAt: expect.any(String) },
      ]);
      // A near miss never deletes: the guess stays a guess, and the key stays.
      const guessed = createBufferIO();
      expect(
        await runCli(
          ["state", "delete", "hello", "cursor", "--json", "--api-url", address],
          guessed,
        ),
      ).toBe(2);
      expect(JSON.parse(guessed.stdoutText)).toMatchObject({ code: "EXACT_NAME_REQUIRED" });
      expect((await state("get", "hello-webhook", "cursor")).output.value).toEqual({ id: 123 });
      expect((await state("delete", "hello-webhook", "cursor")).output.state).toBe("deleted");
      expect((await state("delete", "hello-webhook", "cursor")).output.state).toBe(
        "already absent (no-op)",
      );
      expect((await state("get", "hello-webhook", "cursor")).output.state).toBe(
        "absent: no value under this key",
      );
      expect((await state("list", "hello-webhook")).output.state).toBe("0 keys");
    } finally {
      await app.close();
    }
  });

  it("follows a running run's logs until it is terminal, each chunk once", async ({ signal }) => {
    const io = createBufferIO();
    const stateDirectory = await temporaryDirectory("swizzle-cli-logs-follow-");
    // The child holds after phase-one until the test creates the gate file, so the
    // first poll sees a running run.
    const gatePath = path.join(stateDirectory, "gate");
    const automationDirectory = path.join(stateDirectory, "streaming-logs");
    await mkdir(automationDirectory);
    await writeFile(
      path.join(automationDirectory, "config.yaml"),
      [
        "name: streaming-logs",
        "version: 1.0.0",
        "entrypoint: main.js",
        "trigger:",
        "  type: webhook",
        "  path: /streaming-logs",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(automationDirectory, "main.js"),
      [
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
    );

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    await platform.deployAutomationToPlatform({ environment: "local", automationDirectory });
    const queued = await platform.startManualRun({
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
    let following: Promise<number> | undefined;
    const app = await buildTestServer({ platform });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      await waitFor(
        signal,
        async () =>
          settled || (await platform.getPlatformRun(queued.runId)).stderr.includes("phase-one"),
      );
      // The CLI waits 2 s between polls; here that wait passes at once, every other timer stays real.
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) =>
        realSetTimeout(callback, ms === 2_000 ? 0 : ms)) as typeof setTimeout);
      let followed = false;
      following = runCli(
        ["logs", "--run", queued.runId, "--follow", "--json", "--api-url", address],
        io,
      ).finally(() => {
        followed = true;
      });
      await waitFor(signal, () => followed || io.stdoutText.includes("\n"));
      await writeFile(gatePath, "");

      expect(await following).toBe(0);
      expect((await processing)?.status).toBe("succeeded");
      const lines = io.stdoutText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const result = lines.pop();
      expect(lines.map((line) => line.log).join("")).toBe("phase-one\nphase-two\n");
      expect(result).toMatchObject({ run: { status: "succeeded" }, stdout: '{"ok":true}\n' });
    } finally {
      // Release the child and settle both tasks before the shared cleanup removes their directories.
      await writeFile(gatePath, "");
      await Promise.allSettled([processing, following]);
      vi.restoreAllMocks();
      await app.close();
    }
  });

  it("runs inspect shows the parsed result and a stderr preview, without attempts or config", async () => {
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/runs/a3c1e5f0-0b2d-4c7e-9f11-2d3e4f5a6b7c")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            executions: [
              {
                attempt: 1,
                executionNumber: 1,
                resumedAfter: null,
                status: "succeeded",
                stderr: "attempt noise",
                stdout: "{}",
                workerName: "local",
              },
            ],
            attemptsMade: 1,
            attemptsMax: 3,
            automationSlug: "invoice-sync",
            payload: { order: 42 },
            config: { runtime: { execution_mode: "process" } },
            finishedAt: "2026-07-07T10:00:05Z",
            dashboardUrl: null,
            placement: null,
            queuedAt: "2026-07-07T10:00:00Z",
            runId: "a3c1e5f0-0b2d-4c7e-9f11-2d3e4f5a6b7c",
            startedAt: "2026-07-07T10:00:01Z",
            status: "succeeded",
            stderr: "very long debug output",
            stdout: '{"voucherId":"21f40af2"}',
            triggerType: "webhook",
          }),
        );
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "NOT_FOUND", message: "not found" }));
    });

    const address = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const info = server.address();
        resolve(`http://127.0.0.1:${typeof info === "object" && info ? info.port : 0}`);
      });
    });

    try {
      const io = createBufferIO();
      const exitCode = await runCli(
        ["runs", "inspect", "a3c1e5f0-0b2d-4c7e-9f11-2d3e4f5a6b7c", "--api-url", address],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stdoutText).toBe(
        [
          "run:",
          "  id: a3c1e5f0-0b2d-4c7e-9f11-2d3e4f5a6b7c",
          "  payload:",
          "    order: 42",
          "  automation: invoice-sync",
          "  status: succeeded",
          "  trigger: webhook",
          "  attempts: 1/3",
          "  worker: local",
          '  queuedAt: "2026-07-07T10:00:00Z"',
          '  startedAt: "2026-07-07T10:00:01Z"',
          '  finishedAt: "2026-07-07T10:00:05Z"',
          "  result:",
          "    voucherId: 21f40af2",
          "  stderr: very long debug output",
          "",
        ].join("\n"),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("counts a resumed run's attempts the way its attempt history lists them", async () => {
    const platform = await testPlatform();
    const automationDirectory = await temporaryDirectory("swizzle-cli-resumed-");
    const failedOnce = path.join(automationDirectory, "failed-once");
    await writeFile(
      path.join(automationDirectory, "config.yaml"),
      [
        "name: resumed-run",
        "version: 1.0.0",
        "entrypoint: main.js",
        "trigger: { type: webhook, path: /resumed-run }",
        "runtime: { retry: { max_attempts: 3 } }",
        "",
      ].join("\n"),
    );
    // Waits for two approvals, then fails once and succeeds on the retry.
    await writeFile(
      path.join(automationDirectory, "main.js"),
      [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "for (const stepKey of ['gate-1', 'gate-2']) {",
        "  if (steps[stepKey]) continue;",
        "  console.log(JSON.stringify({ $swizzle: { suspend: { reason: 'event', approval: true, stepKey } } }));",
        "  process.exit(0);",
        "}",
        `if (!fs.existsSync(${JSON.stringify(failedOnce)})) {`,
        `  fs.writeFileSync(${JSON.stringify(failedOnce)}, '');`,
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify({ ok: true }));",
        "",
      ].join("\n"),
    );
    await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });
    const run = await platform.enqueuePlatformRun({
      automationName: "resumed-run",
      environment: "local",
    });
    for (const stepKey of ["gate-1", "gate-2"]) {
      expect((await platform.processNextPlatformRun())?.status).toBe("waiting");
      expect(
        await platform.decideApproval({
          approved: true,
          assignee: null,
          comment: null,
          decidedBy: { kind: "link" },
          runId: run.runId,
          stepKey,
        }),
      ).toMatchObject({ status: "resolved" });
    }
    expect((await platform.processNextPlatformRun())?.status).toBe("queued");
    expect((await platform.processNextPlatformRun())?.status).toBe("succeeded");
    const app = await buildTestServer({ platform });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const io = createBufferIO();
      expect(await runCli(["runs", "inspect", run.runId, "--json", "--api-url", address], io)).toBe(
        0,
      );
      const shown = JSON.parse(io.stdoutText).run;
      // A resume spends no retry: the executions before the failure belong to attempt 1 of 3.
      expect(shown.attempts).toBe("2/3");
      expect(
        shown.attemptHistory.map(({ attempt, resumedAfter, status }: Record<string, unknown>) => ({
          attempt,
          resumedAfter,
          status,
        })),
      ).toEqual([
        { attempt: 1, resumedAfter: null, status: "suspended" },
        { attempt: 1, resumedAfter: "approval gate-1", status: "suspended" },
        { attempt: 1, resumedAfter: "approval gate-2", status: "retrying" },
        { attempt: 2, resumedAfter: null, status: "succeeded" },
      ]);
    } finally {
      await app.close();
      await platform.close();
    }
  });

  it("posts an event resolution through runs resolve-event", async () => {
    const requests: { body: unknown; method: string; url: string | undefined }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        requests.push({
          body: raw.length > 0 ? JSON.parse(raw) : null,
          method: request.method ?? "",
          url: request.url,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            resumed: true,
            runId: "b4d2f6a1-1c3e-4d8f-a022-3e4f5a6b7c8d",
            stepKey: "event-step",
          }),
        );
      });
    });

    const address = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const info = server.address();
        resolve(`http://127.0.0.1:${typeof info === "object" && info ? info.port : 0}`);
      });
    });

    try {
      const resolveIo = createBufferIO();
      expect(
        await runCli(
          [
            "runs",
            "resolve-event",
            "b4d2f6a1-1c3e-4d8f-a022-3e4f5a6b7c8d",
            "event-step",
            "--payload",
            '{"ok":true}',
            "--json",
            "--api-url",
            address,
          ],
          resolveIo,
        ),
      ).toBe(0);

      expect(requests).toEqual([
        {
          body: { value: { ok: true } },
          method: "POST",
          url: "/runs/b4d2f6a1-1c3e-4d8f-a022-3e4f5a6b7c8d/events/event-step?environment=local",
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("manages per-automation timeout grants and shows them in inspect", async () => {
    const grantDir = await temporaryDirectory("swizzle-cli-grant-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(grantDir, "artifacts"),
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
    });
    const app = await buildTestServer({
      dashboard: createDashboardStub("hello-webhook"),
      platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const cli = async (...args: string[]) => {
      const io = createBufferIO();
      const exitCode = await runCli([...args, "--json", "--api-url", address], io);
      return { exitCode, json: JSON.parse(io.stdoutText) };
    };
    const set = ["timeout-grant", "set", "hello-webhook", "3h", "--note", "long batch"];

    try {
      expect((await cli(...set)).json).toMatchObject({
        automation: "hello-webhook",
        maxTimeout: "3h",
        note: "long batch",
        state: "granted",
      });
      expect((await cli(...set)).json.state).toBe("already granted (no-op)");
      expect((await cli("timeout-grant", "show", "hello-webhook")).json).toMatchObject({
        maxTimeout: "3h",
        maxTimeoutMs: 10_800_000,
      });
      expect((await cli("timeout-grant")).json.grants).toEqual([
        { automation: "hello-webhook", maxTimeout: "3h", note: "long batch" },
      ]);
      expect((await cli("inspect", "hello-webhook")).json.automation.timeoutGrant).toBe(
        "3h (long batch)",
      );

      const badDuration = await cli("timeout-grant", "set", "hello-webhook", "3hours");
      expect(badDuration.exitCode).toBe(3);

      // Removal takes the exact name, so a near miss cannot strip another automation's grant.
      const fuzzy = await cli("timeout-grant", "remove", "hello", "--yes");
      expect(fuzzy.exitCode).toBe(2);
      expect(fuzzy.json.code).toBe("EXACT_NAME_REQUIRED");

      const remove = ["timeout-grant", "remove", "hello-webhook", "--yes"];
      expect((await cli(...remove)).json.state).toBe("removed");
      expect((await cli(...remove)).json.state).toBe("no grant (no-op)");
      expect((await cli("timeout-grant", "show", "hello-webhook")).json.grant).toBe(
        "none; the instance ceiling applies",
      );
    } finally {
      await app.close();
    }
  });
});

describe("swizzle run locally", () => {
  beforeEach(withoutProfile);
  it("runs an automation with inline JSON payload", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(
      [
        "run",
        path.join(repoRoot, "infra/examples/hello-webhook"),
        "--payload",
        '{"source":"cli-inline"}',
        "--json",
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText).toBe("");
    expect(JSON.parse(io.stdoutText).result).toMatchObject({
      message: "Hello from Swizzle",
      payload: { source: "cli-inline" },
      trigger_type: "manual",
    });
  });

  it("runs an automation in the local environment", async () => {
    const directory = await temporaryDirectory("swizzle-cli-");
    await writeFile(
      path.join(directory, "config.yaml"),
      "name: environment-echo\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: cron\n  schedule: '0 * * * *'\n",
    );
    await writeFile(
      path.join(directory, "main.js"),
      "console.log(JSON.stringify({ environment: process.env.SWIZZLE_ENV }));\n",
    );
    const io = createBufferIO();

    const exitCode = await runCli(["run", directory, "--json"], io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdoutText).result).toEqual({ environment: "local" });
  });

  it("runs a check without the shell's state files and returns a long green answer whole", async () => {
    vi.stubEnv("SWIZZLE_STATE_FILE", "/parent/state.json");
    vi.stubEnv("SWIZZLE_STEPS_FILE", "/parent/steps.json");
    const directory = await temporaryDirectory("swizzle-cli-check-");
    await writeFile(
      path.join(directory, "config.yaml"),
      "name: deals-export\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: cron\n  schedule: '0 * * * *'\napi_check:\n  mode: active\n",
    );
    await writeFile(path.join(directory, "main.js"), "console.log('{}');\n");
    await writeFile(
      path.join(directory, "check.js"),
      [
        "const checked = Array.from({ length: 1000 }, (_, page) => 'GET /v1/deals?page=' + page);",
        "const files = [process.env.SWIZZLE_STATE_FILE, process.env.SWIZZLE_STEPS_FILE];",
        "console.log(JSON.stringify({ ok: true, checked, files }));",
        "",
      ].join("\n"),
    );
    const io = createBufferIO();

    const exitCode = await runCli(["run", directory, "--check", "--json"], io);

    expect(exitCode).toBe(0);
    const output = JSON.parse(io.stdoutText);
    expect(output.check.status).toBe("green");
    expect(output.result.checked).toHaveLength(1000);
    expect(output.result.files).toEqual([null, null]);
  });

  it.each([
    [
      "secrets:\n  - REVIEW_CORE_MISSING_SECRET\n",
      "console.log('{}');",
      "MISSING_REQUIRED_SECRETS",
    ],
    ["", "console.error('HTTPError: 401 Unauthorized'); process.exit(1);", "API_CHECK_CREDENTIALS"],
  ])(
    "keeps the local check failure code for secrets=%s source=%s: %s",
    async (secrets, source, code) => {
      vi.stubEnv("REVIEW_CORE_MISSING_SECRET", undefined);
      const directory = await temporaryDirectory("swizzle-cli-check-failure-");
      await writeFile(
        path.join(directory, "config.yaml"),
        "name: check-failure\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: cron\n  schedule: '0 * * * *'\napi_check:\n  mode: active\n" +
          secrets,
      );
      await writeFile(path.join(directory, "main.js"), "console.log('{}');");
      await writeFile(path.join(directory, "check.js"), source);
      const io = createBufferIO();
      expect(await runCli(["run", directory, "--check", "--json"], io)).toBe(1);
      expect(JSON.parse(io.stdoutText)).toMatchObject({ code });
      if (code === "MISSING_REQUIRED_SECRETS") {
        expect(JSON.parse(io.stdoutText)).toMatchObject({
          help: ["Export the missing secret names in your current shell before running locally."],
        });
      }
    },
  );

  it("runs an automation with a JSON payload file", async () => {
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-");

    const payloadFilePath = path.join(directory, "payload.json");
    await writeFile(payloadFilePath, '{"source":"cli-file"}', "utf8");

    const exitCode = await runCli(
      [
        "run",
        path.join(repoRoot, "infra/examples/hello-webhook"),
        "--payload-file",
        payloadFilePath,
        "--json",
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdoutText).result).toMatchObject({
      payload: { source: "cli-file" },
    });
  });
});
