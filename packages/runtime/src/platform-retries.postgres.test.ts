import { copyFile, writeFile } from "node:fs/promises";

import path from "node:path";

import { describe, expect, it } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { temporaryDirectory } from "../../../test/support.js";

import { createAutomationFixture, packageRoot, repoRoot } from "../test/platform-harness.js";

describe("platform retries", () => {
  it("retries retryable failures and dead-letters terminal failures", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(packageRoot, "test-fixtures/retry-then-success"),
      deploymentId: "5664fdf3-97b7-5061-a66b-0d19a3d5aba9",
    });

    await platform.enqueuePlatformRun({
      environment: "local",
      automationName: "retry-then-success",
      runId: "998c0752-9f9e-5670-a223-a28846b4cae5",
    });

    expect((await platform.processNextPlatformRun())?.status).toBe("queued");
    expect((await platform.processNextPlatformRun())?.status).toBe("queued");
    expect((await platform.processNextPlatformRun())?.status).toBe("succeeded");

    const retriedRun = await platform.getPlatformRun("998c0752-9f9e-5670-a223-a28846b4cae5");
    expect(retriedRun).toMatchObject({
      executions: [
        { executionNumber: 1, status: "retrying" },
        { executionNumber: 2, status: "retrying" },
        { executionNumber: 3, status: "succeeded" },
      ],
      attemptsMade: 3,
      status: "succeeded",
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(packageRoot, "test-fixtures/invalid-json-output"),
      deploymentId: "0dcba96b-1cff-58bf-93c7-a12d576330b2",
    });

    await platform.enqueuePlatformRun({
      environment: "local",
      automationName: "invalid-json-output",
      runId: "90e48bbc-1761-5820-9375-66f052426b34",
    });

    const terminalRun = await platform.processNextPlatformRun();
    expect(terminalRun?.status).toBe("dead-lettered");

    const persistedTerminalRun = await platform.getPlatformRun(
      "90e48bbc-1761-5820-9375-66f052426b34",
    );
    expect(persistedTerminalRun).toMatchObject({
      executions: [
        {
          executionNumber: 1,
          errorClassification: "terminal",
          status: "dead-lettered",
        },
      ],
      deadLetterReason: "terminal-failure",
      errorCode: "PROCESS_STDOUT_INVALID_JSON",
      status: "dead-lettered",
    });
  });

  it("memoizes completed run steps across retry attempts", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "let value = steps['step-a'];",
        "let executed = false;",
        "if (!Object.hasOwn(steps, 'step-a')) {",
        "  executed = true;",
        "  value = { executions: 1, producedOnAttempt: Number(process.env.SWIZZLE_ATTEMPT) };",
        "  process.stderr.write(JSON.stringify({ type: 'step_result', key: 'step-a', value }) + '\\n');",
        "}",
        "if (process.env.SWIZZLE_ATTEMPT === '1') {",
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify({ attempt: Number(process.env.SWIZZLE_ATTEMPT), executed, value }));",
        "",
      ].join("\n"),
      name: "step-memoization",
      triggerLines: ["  type: webhook", "  path: /step-memoization"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "e137ed51-11ef-5297-ac8d-c47aa06299ef",
    });
    await platform.enqueuePlatformRun({
      environment: "local",
      automationName: "step-memoization",
      runId: "97e7adb3-7b8d-5ded-af2f-af2b0912de58",
    });

    expect((await platform.processNextPlatformRun())?.status).toBe("queued");
    const secondAttempt = await platform.processNextPlatformRun();
    expect(secondAttempt?.status).toBe("succeeded");
    expect(secondAttempt?.result).toEqual({
      attempt: 2,
      executed: false,
      value: { executions: 1, producedOnAttempt: 1 },
    });

    const persisted = await platform.getPlatformRun("97e7adb3-7b8d-5ded-af2f-af2b0912de58");
    expect(persisted.executions).toMatchObject([
      { executionNumber: 1, status: "retrying" },
      { executionNumber: 2, status: "succeeded" },
    ]);
  });

  it("gives a resumed run segment a fresh retry budget", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const waitUntil = "2026-01-01T00:00:00.000Z";
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "if (!Object.hasOwn(steps, 'sleep-step')) {",
        `  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'sleep', stepKey: 'sleep-step', until: '${waitUntil}' } } }) + '\\n');`,
        "  process.exit(0);",
        "}",
        "const attempt = Number(process.env.SWIZZLE_ATTEMPT);",
        "const execution = Number(process.env.SWIZZLE_EXECUTION);",
        "if (execution < 4) {",
        "  process.stderr.write('retry-attempt-' + attempt + '\\n');",
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify({ attempt, execution, slept: steps['sleep-step'] }));",
        "",
      ].join("\n"),
      name: "resume-retry-budget",
      triggerLines: ["  type: webhook", "  path: /resume-retry-budget"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "e2be5b22-2dc5-50cf-941b-cb7fc5677cbf",
    });
    await platform.enqueuePlatformRun({
      environment: "local",
      automationName: "resume-retry-budget",
      runId: "fe7b9ff7-0cbc-59dc-a162-8407727c9f91",
    });

    expect((await platform.processNextPlatformRun())?.status).toBe("waiting");
    await platform.resumeDueWaitingRuns({ environment: "local", now: new Date(waitUntil) });
    expect((await platform.processNextPlatformRun())?.status).toBe("queued");
    expect((await platform.processNextPlatformRun())?.status).toBe("queued");
    const succeeded = await platform.processNextPlatformRun();
    expect(succeeded).toMatchObject({
      status: "succeeded",
      // The resume spent no retry: the fourth execution is the segment's third attempt.
      result: {
        attempt: 3,
        execution: 4,
        slept: { sleptUntil: waitUntil },
      },
    });

    const persisted = await platform.getPlatformRun("fe7b9ff7-0cbc-59dc-a162-8407727c9f91");
    expect(persisted).toMatchObject({
      attemptsMade: 3,
      resumeCount: 1,
      status: "succeeded",
    });
    expect(persisted.executions).toMatchObject([
      { executionNumber: 1, status: "suspended" },
      { executionNumber: 2, status: "retrying" },
      { executionNumber: 3, status: "retrying" },
      { executionNumber: 4, status: "succeeded" },
    ]);
  });

  it("dead-letters oversize step results without retrying", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const value = 'x'.repeat(65 * 1024);",
        "process.stderr.write(JSON.stringify({ type: 'step_result', key: 'too-big', value }) + '\\n');",
        "setTimeout(() => console.log(JSON.stringify({ ok: true })), 100);",
        "",
      ].join("\n"),
      name: "step-limit",
      triggerLines: ["  type: webhook", "  path: /step-limit"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "72e54f50-7bbf-5746-92a1-192691b1b829",
    });
    await platform.enqueuePlatformRun({
      environment: "local",
      automationName: "step-limit",
      runId: "3b6bef17-740f-5360-83cb-eb524f84fa3c",
    });

    const processed = await platform.processNextPlatformRun();
    expect(processed?.status).toBe("dead-lettered");

    const persisted = await platform.getPlatformRun("3b6bef17-740f-5360-83cb-eb524f84fa3c");
    expect(persisted).toMatchObject({
      executions: [
        {
          executionNumber: 1,
          errorClassification: "terminal",
          errorCode: "AUTOMATION_STEP_LIMIT_EXCEEDED",
          status: "dead-lettered",
        },
      ],
      attemptsMade: 1,
      deadLetterReason: "terminal-failure",
      errorCode: "AUTOMATION_STEP_LIMIT_EXCEEDED",
      status: "dead-lettered",
    });
  });

  // NaN is no JSON number: the runtime cannot parse Python's `NaN` token, and JSON.stringify
  // writes null, so a step result would be dropped or replayed changed on the next attempt.
  it.each([
    {
      entrypoint: "main.py",
      main: [
        "import json",
        "import swizzle_sdk as sdk",
        "sdk.run_step('measure', lambda: {'ratio': float('nan')})",
        "print(json.dumps({'ok': True}))",
      ],
      sdk: { source: "packages/sdk-py/swizzle_sdk.py", copy: "swizzle_sdk.py" },
      error:
        "ValueError: Swizzle step 'measure' result is not JSON: Out of range float values are not JSON compliant: nan",
    },
    {
      entrypoint: "main.ts",
      main: [
        'import {runStep} from "./swizzle-sdk.ts";',
        "await runStep('measure', () => ({ ratio: Number.NaN }));",
        "console.log(JSON.stringify({ ok: true }));",
      ],
      sdk: { source: "packages/sdk-ts/src/index.ts", copy: "swizzle-sdk.ts" },
      error: 'Error: Swizzle step "measure" result is not JSON: NaN at "ratio" has no JSON form.',
    },
  ])(
    "fails a $entrypoint run whose SDK step returns NaN",
    async ({ entrypoint, main, sdk, error }) => {
      const stateDirectory = await temporaryDirectory("swizzle-platform-");
      const platform = await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      });
      const automationDirectory = await temporaryDirectory("swizzle-fixture-");
      await writeFile(
        path.join(automationDirectory, "config.yaml"),
        `name: step-nan\nversion: 1.0.0\nentrypoint: ${entrypoint}\ntrigger:\n  type: webhook\n  path: /step-nan\nruntime:\n  retry:\n    max_attempts: 1\n`,
      );
      await writeFile(path.join(automationDirectory, entrypoint), `${main.join("\n")}\n`);
      await copyFile(path.join(repoRoot, sdk.source), path.join(automationDirectory, sdk.copy));
      await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory,
        deploymentId: "c0a528ff-accf-5e40-bf2b-1f45d86ddaca",
      });
      await platform.enqueuePlatformRun({
        environment: "local",
        automationName: "step-nan",
        runId: "eabc5c40-877a-5c47-8536-b612cf7d1fea",
      });

      const processed = await platform.processNextPlatformRun();
      expect(processed?.status).toBe("dead-lettered");
      expect(processed?.stderr.split("\n")).toContain(error);
    },
  );
});
