import path from "node:path";

import { DEFAULT_PROJECT_ID } from "@swizzle/db";

import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

import { createAutomationFixture } from "../test/platform-harness.js";

describe("platform invocations", () => {
  it("suspends a parent run for a child automation and resumes with the child result", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const childDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const input = fs.readFileSync(0, 'utf8');",
        "const payload = input.length > 0 ? JSON.parse(input) : null;",
        "console.log(JSON.stringify({",
        "  payload,",
        "  parentRunId: process.env.SWIZZLE_PARENT_RUN_ID ?? null,",
        "  triggerType: process.env.SWIZZLE_TRIGGER_TYPE,",
        "}));",
        "",
      ].join("\n"),
      name: "child-worker",
      triggerLines: ["  type: webhook", "  path: /child-worker"],
    });
    const parentDirectory = await createAutomationFixture({
      configLines: ["secrets: [PARENT_SECRET]", "api_check: { mode: passive }"],
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "if (!Object.hasOwn(steps, 'invoke-child')) {",
        "  process.stdout.write(JSON.stringify({ $swizzle: { suspend: {",
        "    reason: 'child',",
        "    stepKey: 'invoke-child',",
        "    automation: 'child-worker',",
        "    payload: { from: 'parent', secret: process.env.PARENT_SECRET },",
        "  } } }) + '\\n');",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({",
        "  attempt: Number(process.env.SWIZZLE_ATTEMPT),",
        "  execution: Number(process.env.SWIZZLE_EXECUTION),",
        "  child: steps['invoke-child'],",
        "}));",
        "",
      ].join("\n"),
      name: "parent-invoker",
      triggerLines: ["  type: webhook", "  path: /parent-invoker"],
    });

    await platform.upsertSecret("PARENT_SECRET", "parent-secret-value", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: childDirectory,
      deploymentId: "dfc10e2c-89b1-5ba8-a0f9-5e12650516e8",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: parentDirectory,
      deploymentId: "cdd05433-18da-5fc7-b33a-bcf8fc569c4b",
    });
    const parentRun = await platform.startManualRun({
      environment: "local",
      automationName: "parent-invoker",
      payload: { root: true },
    });

    const suspendedParent = await platform.processNextPlatformRun();
    expect(suspendedParent).toMatchObject({
      runId: parentRun.runId,
      status: "waiting",
      wait: { reason: "child" },
    });

    const childRun = await platform.processNextPlatformRun();
    expect(childRun).toMatchObject({
      parentRunId: parentRun.runId,
      parentStepKey: "invoke-child",
      status: "succeeded",
    });
    // The parent's output is redacted, but the payload it hands its child is not.
    expect(childRun?.result).toMatchObject({
      parentRunId: parentRun.runId,
      payload: { from: "parent", secret: "parent-secret-value" },
      triggerType: "chain",
    });

    const queuedParent = await platform.getPlatformRun(parentRun.runId);
    expect(queuedParent).toMatchObject({
      resumeCount: 1,
      status: "queued",
      wait: null,
    });

    const resumedParent = await platform.processNextPlatformRun();
    expect(resumedParent).toMatchObject({
      runId: parentRun.runId,
      status: "succeeded",
    });
    expect(resumedParent?.result).toMatchObject({
      attempt: 1,
      execution: 2,
      child: {
        automation: "child-worker",
        errorCode: null,
        result: {
          parentRunId: parentRun.runId,
          payload: { from: "parent" },
          triggerType: "chain",
        },
        runId: childRun?.runId,
        status: "succeeded",
      },
    });

    const persistedParent = await platform.getPlatformRun(parentRun.runId);
    expect(persistedParent.executions).toMatchObject([
      { executionNumber: 1, status: "suspended" },
      { executionNumber: 2, status: "succeeded" },
    ]);
    expect(persistedParent.executions[0]?.stdout).toContain('"secret":"[REDACTED]"');
  });

  it("dead-letters malformed suspend payloads without retrying", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "console.log(JSON.stringify({ $swizzle: { suspend: {",
        "  reason: 'sleep',",
        "  stepKey: 'bad-sleep',",
        "  until: 'not-a-date',",
        "} } }));",
        "",
      ].join("\n"),
      name: "bad-suspend",
      triggerLines: ["  type: webhook", "  path: /bad-suspend"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "ccf3d0f0-dc72-5a17-9a3a-6c5dc12fece0",
    });
    await platform.enqueuePlatformRun({
      environment: "local",
      automationName: "bad-suspend",
      runId: "f4caf0a2-2b1c-5fbb-9f8a-69f9c46adb0b",
    });

    const processed = await platform.processNextPlatformRun();
    expect(processed).toMatchObject({
      attemptsMade: 1,
      deadLetterReason: "terminal-failure",
      errorCode: "SUSPEND_PAYLOAD_INVALID",
      status: "dead-lettered",
    });
    expect(processed?.executions).toMatchObject([
      {
        executionNumber: 1,
        errorClassification: "terminal",
        errorCode: "SUSPEND_PAYLOAD_INVALID",
        status: "dead-lettered",
      },
    ]);
  });

  it("dead-letters child invokes with an unknown target without retrying", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "console.log(JSON.stringify({ $swizzle: { suspend: {",
        "  reason: 'child',",
        "  stepKey: 'missing-child',",
        "  automation: 'missing-target',",
        "  payload: {},",
        "} } }));",
        "",
      ].join("\n"),
      name: "unknown-invoke-target",
      triggerLines: ["  type: webhook", "  path: /unknown-invoke-target"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "288984ff-440c-5b2c-a63e-dc2f060becf1",
    });
    await platform.enqueuePlatformRun({
      environment: "local",
      automationName: "unknown-invoke-target",
      runId: "0fd50f19-ee7c-5307-bfb2-a6938886706c",
    });

    const processed = await platform.processNextPlatformRun();
    expect(processed).toMatchObject({
      attemptsMade: 1,
      deadLetterReason: "terminal-failure",
      errorCode: "INVOKE_TARGET_NOT_FOUND",
      status: "dead-lettered",
    });
    expect(processed?.executions).toMatchObject([
      {
        executionNumber: 1,
        errorClassification: "terminal",
        errorCode: "INVOKE_TARGET_NOT_FOUND",
        status: "dead-lettered",
      },
    ]);
  });

  it("dead-letters child invokes that exceed the invoke depth limit", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "process.stdout.write(JSON.stringify({ $swizzle: { suspend: {",
        "  reason: 'child',",
        "  stepKey: 'self',",
        "  automation: 'self-invoker',",
        "  payload: { depth: Number(process.env.SWIZZLE_ATTEMPT) },",
        "} } }) + '\\n');",
        "",
      ].join("\n"),
      name: "self-invoker",
      triggerLines: ["  type: webhook", "  path: /self-invoker"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "aad77d25-3881-5da1-909e-c03c6746fbfd",
    });
    await platform.startManualRun({
      environment: "local",
      automationName: "self-invoker",
      payload: {},
    });

    let depthFailure = null as Awaited<ReturnType<typeof platform.processNextPlatformRun>>;
    for (let index = 0; index < 10; index += 1) {
      const processed = await platform.processNextPlatformRun();
      if (processed?.errorCode === "INVOKE_DEPTH_EXCEEDED") {
        depthFailure = processed;
        break;
      }
    }

    expect(depthFailure).toMatchObject({
      attemptsMade: 1,
      deadLetterReason: "terminal-failure",
      errorCode: "INVOKE_DEPTH_EXCEEDED",
      invokeDepth: 8,
      status: "dead-lettered",
    });
    expect(depthFailure?.executions).toMatchObject([
      {
        executionNumber: 1,
        errorClassification: "terminal",
        errorCode: "INVOKE_DEPTH_EXCEEDED",
        status: "dead-lettered",
      },
    ]);
  });
});
