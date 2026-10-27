import { once } from "node:events";

import { access, readFile, writeFile } from "node:fs/promises";

import { createServer, type ServerResponse } from "node:http";

import path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { temporaryDirectory, waitFor } from "../../../test/support.js";

import { createAutomationFixture } from "../test/platform-harness.js";

describe("platform cancellation", () => {
  it("rejects a late suspension report after the parent is cancelled", async ({ signal }) => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const ready = path.join(stateDirectory, "ready");
    const release = path.join(stateDirectory, "release");
    const childDirectory = await createAutomationFixture({
      mainJs: ["console.log(JSON.stringify({ ok: true }));", ""].join("\n"),
      name: "race-child",
      triggerLines: ["  type: webhook", "  path: /race-child"],
    });
    const parentDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
        "const timer = setInterval(() => {",
        `if (!fs.existsSync(${JSON.stringify(release)})) return;`,
        "clearInterval(timer);",
        "process.stdout.write(JSON.stringify({ $swizzle: { suspend: {",
        "  reason: 'child',",
        "  stepKey: 'invoke-child',",
        "  automation: 'race-child',",
        "  payload: {},",
        "} } }) + '\\n');",
        "}, 10);",
        "",
      ].join("\n"),
      name: "race-parent",
      triggerLines: ["  type: webhook", "  path: /race-parent"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: childDirectory,
      deploymentId: "c404b3f6-e5b2-5c05-8d52-eb2ae8d0893d",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: parentDirectory,
      deploymentId: "e66a9dd3-6b35-5a44-b49a-8a97d41c7041",
    });
    const parentRun = await platform.startManualRun({
      environment: "local",
      automationName: "race-parent",
      payload: {},
    });

    const processing = platform.processNextPlatformRun();
    // Settled in finally, even when readiness or cancellation fails first.
    processing.catch(() => undefined);
    try {
      await waitFor(
        signal,
        async () =>
          await access(ready).then(
            () => true,
            () => false,
          ),
      );
      await platform.cancelPlatformRun(parentRun.runId);
    } finally {
      await writeFile(release, "go");
      await Promise.allSettled([processing]);
    }
    expect((await processing)?.status).toBe("dead-lettered");
    expect(await platform.store.listChildRuns({ parentRunId: parentRun.runId })).toEqual([]);
    await expect(platform.processNextPlatformRun()).resolves.toBeNull();
    expect((await platform.getPlatformRun(parentRun.runId)).status).toBe("dead-lettered");
  });

  it("cancels a waiting parent and its non-terminal child without resurrecting the parent", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const childWaitUntil = "2031-01-01T00:00:00.000Z";
    const childDirectory = await createAutomationFixture({
      mainJs: [
        `process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'sleep', stepKey: 'child-sleep', until: '${childWaitUntil}' } } }) + '\\n');`,
        "",
      ].join("\n"),
      name: "cancelled-child",
      triggerLines: ["  type: webhook", "  path: /cancelled-child"],
    });
    const parentDirectory = await createAutomationFixture({
      mainJs: [
        "process.stdout.write(JSON.stringify({ $swizzle: { suspend: {",
        "  reason: 'child',",
        "  stepKey: 'child-wait',",
        "  automation: 'cancelled-child',",
        "  payload: { ok: true },",
        "} } }) + '\\n');",
        "",
      ].join("\n"),
      name: "cancel-waiting-parent",
      triggerLines: ["  type: webhook", "  path: /cancel-waiting-parent"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: childDirectory,
      deploymentId: "be33ad73-5d54-5de3-aa82-2d20609b03ed",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: parentDirectory,
      deploymentId: "b4cd0d15-a3d9-561d-b53f-e825931f85e6",
    });
    const parentRun = await platform.startManualRun({
      environment: "local",
      automationName: "cancel-waiting-parent",
      payload: {},
    });

    await platform.processNextPlatformRun();
    const waitingParent = await platform.getPlatformRun(parentRun.runId);
    expect(waitingParent).toMatchObject({ status: "waiting", wait: { reason: "child" } });
    const waitingChild = await platform.processNextPlatformRun();
    expect(waitingChild).toMatchObject({
      parentRunId: parentRun.runId,
      status: "waiting",
      wait: { reason: "sleep", until: childWaitUntil },
    });

    const cancelResult = await platform.cancelPlatformRun(parentRun.runId);
    expect(cancelResult.alreadyTerminal).toBe(false);
    expect(cancelResult.run).toMatchObject({
      errorCode: "RUN_CANCELLED",
      status: "dead-lettered",
      wait: null,
    });

    expect(await platform.processNextPlatformRun()).toBeNull();
    const cancelledChild = await platform.getPlatformRun(waitingChild?.runId ?? "");
    expect(cancelledChild).toMatchObject({
      errorCode: "RUN_CANCELLED",
      status: "dead-lettered",
      wait: null,
    });
    const lateTimerSweep = await platform.resumeDueWaitingRuns({
      environment: "local",
      now: new Date(childWaitUntil),
    });
    expect(lateTimerSweep).toEqual({
      resumedCount: 0,
      resumedRunIds: [],
      skippedRunIds: [],
    });
    const cancelledParent = await platform.getPlatformRun(parentRun.runId);
    expect(cancelledParent).toMatchObject({
      errorCode: "RUN_CANCELLED",
      status: "dead-lettered",
      wait: null,
    });
    expect(cancelledParent.resumeCount).toBe(0);
  });

  // The API that receives a cancel and the worker that runs the attempt are separate processes on
  // the packaged stack (f-220). A fresh copy of the runtime's modules plays the API: it shares only
  // the store with this worker.
  it("stops a running attempt at its next heartbeat when another process cancels its run", async ({
    signal,
  }) => {
    // The heartbeat is the worker's only news of a cancel; the test fires it.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: await createAutomationFixture({
        mainJs: "setTimeout(() => process.stdout.write('{}'), 30_000);\n",
        name: "cancelled-elsewhere",
        triggerLines: ["  type: webhook", "  path: /cancelled-elsewhere"],
      }),
      deploymentId: "dcdc8cb1-c0d7-53ea-bf32-0931958efedb",
    });
    const run = await platform.startManualRun({
      environment: "local",
      automationName: "cancelled-elsewhere",
      payload: {},
    });
    const processing = platform.processNextPlatformRun();
    await waitFor(
      signal,
      async () => (await platform.getPlatformRun(run.runId)).executions[0]?.status === "running",
    );
    vi.resetModules();
    const { createPlatformServiceFacade } = await import("./platform-service-facade.js");
    const api = createPlatformServiceFacade({
      checkReadiness: async () => ({ checks: {}, ok: true }) as never,
      close: async () => {},
      listReadinessWorkers: async () => [],
      placeRun: async () => null,
      queue: {
        close: async () => {},
        enqueue: async () => {},
        enqueueCheck: async () => {},
        hasJob: async () => false,
      },
      runMaintenance: async () => ({}) as never,
      store: platform.store,
    });

    await api.cancelPlatformRun(run.runId);
    // The automation itself would end in 30 s; a missed cancel runs into the test's timeout.
    vi.advanceTimersToNextTimer();
    const processed = await processing;

    expect(processed).toMatchObject({
      deadLetterReason: "user-cancelled",
      status: "dead-lettered",
    });
  });

  it("keeps a cancelled running run terminal when the child later exits successfully", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const exitRecord = path.join(stateDirectory, "child-exit.json");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const release = createServer();
    const requested = new Promise<ServerResponse>((resolve) => {
      release.once("request", (_request, response) => resolve(response));
    });
    onTestFinished(() => {
      release.closeAllConnections();
      release.close();
    });
    release.listen(0, "127.0.0.1");
    await once(release, "listening");
    const address = release.address();
    if (address === null || typeof address === "string") throw new Error("No release port");
    const automationDirectory = await createAutomationFixture({
      configLines: ["runtime:", "  timeout: 30s"],
      mainJs: [
        "process.on('SIGTERM', () => {});",
        `process.on('exit', (code) => require('node:fs').writeFileSync(${JSON.stringify(exitRecord)}, JSON.stringify({ code })));`,
        `require('node:http').get('http://127.0.0.1:${address.port}', (response) => {`,
        "  response.resume();",
        "  response.on('end', () => console.log(JSON.stringify({ ok: true })));",
        "});",
        "",
      ].join("\n"),
      name: "cancellable-success",
      triggerLines: ["  type: webhook", "  path: /cancellable-success"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "219bee1b-3429-577a-9de2-8a55ad4666da",
    });

    await platform.enqueuePlatformRun({
      environment: "local",
      automationName: "cancellable-success",
      runId: "8b32656a-c683-5b8a-b003-519b55e92bb4",
    });

    const processing = platform.processNextPlatformRun();
    onTestFinished(() =>
      processing.then(
        () => undefined,
        () => undefined,
      ),
    );
    const response = await Promise.race([
      requested,
      processing.then((run) => {
        throw new Error(`Child finished before requesting release (${run?.status ?? "no run"})`);
      }),
    ]);
    try {
      const cancelled = await platform.cancelPlatformRun("8b32656a-c683-5b8a-b003-519b55e92bb4");
      expect(cancelled.alreadyTerminal).toBe(false);
      expect(cancelled.run.status).toBe("dead-lettered");
    } finally {
      response.end();
    }
    const processedRun = await processing;

    expect(JSON.parse(await readFile(exitRecord, "utf8"))).toEqual({ code: 0 });
    expect(processedRun?.status).toBe("dead-lettered");

    const persistedRun = await platform.getPlatformRun("8b32656a-c683-5b8a-b003-519b55e92bb4");
    expect(persistedRun).toMatchObject({
      executions: [
        {
          executionNumber: 1,
          errorClassification: "terminal",
          errorCode: "RUN_CANCELLED",
          status: "dead-lettered",
        },
      ],
      attemptsMade: 1,
      deadLetterReason: "user-cancelled",
      errorCode: "RUN_CANCELLED",
      status: "dead-lettered",
    });
    expect(persistedRun.result).toBeNull();
  }, 30_000);
});
