import { randomUUID } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { createQueueNameForProfile } from "@swizzle/runtime";
import { describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { TEST_ENCRYPTION_KEY, temporaryDirectory, waitFor } from "../../../test/support.js";
import { createSchedulerService } from "./scheduler.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const appRoot = path.resolve(sourceRoot, "..");
const repoRoot = path.resolve(appRoot, "../..");

describe("scheduler service", () => {
  it("polls another environment on the next tick while a cron backlog is still draining", async ({
    signal,
  }) => {
    const directory = await temporaryDirectory("swizzle-scheduler-backlog-");
    const platform = await testPlatform({ artifactsDirectory: path.join(directory, "artifacts") });
    const fixture = path.join(repoRoot, "packages/runtime/test-fixtures/cron-success");
    const backlog = path.join(directory, "cron-backlog");
    await cp(fixture, backlog, { recursive: true });
    const configPath = path.join(backlog, "config.yaml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace("cron-success", "cron-backlog"),
    );
    for (const automationDirectory of [fixture, backlog]) {
      await platform.deployAutomationToPlatform({ environment: "production", automationDirectory });
    }

    const nextBatch = deferred<Awaited<ReturnType<typeof platform.store.getDueCronTriggers>>>();
    const releaseBatch = deferred<void>();
    const stagingChecked = deferred<void>();
    const getDueCronTriggers = platform.store.getDueCronTriggers.bind(platform.store);
    let productionBatches = 0;
    vi.spyOn(platform.store, "getDueCronTriggers").mockImplementation(async (...args) => {
      const triggers = await getDueCronTriggers(...args);
      if (args[1] === "production" && ++productionBatches === 2) {
        nextBatch.resolve(triggers);
        await releaseBatch.promise;
      }
      return triggers;
    });
    const enqueueDueApiChecks = platform.enqueueDueApiChecks.bind(platform);
    vi.spyOn(platform, "enqueueDueApiChecks").mockImplementation(async (input) => {
      try {
        const checks = await enqueueDueApiChecks(input);
        if (input.environment === "staging") stagingChecked.resolve();
        return checks;
      } catch (error) {
        if (input.environment === "staging") stagingChecked.reject(error);
        throw error;
      }
    });
    const scheduler = await createSchedulerService({
      batchSize: 1,
      listEnvironments: async () => ["production", "staging"],
      platform,
    });
    const trigger = await platform.getAutomationTrigger("cron-backlog", "production");
    const cancelled = deferred<never>();
    const onAbort = () => cancelled.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const firstTick = scheduler.pollOnce(requireDate(trigger.nextRunAt));
    try {
      const [pendingTriggers] = await Promise.race([
        Promise.all([nextBatch.promise, stagingChecked.promise]),
        firstTick.then(() => {
          throw new Error("Expected production to remain held at its second cron batch.");
        }),
        cancelled.promise,
      ]);
      expect(pendingTriggers).toHaveLength(1);
      await platform.deployAutomationToPlatform({
        environment: "staging",
        automationDirectory: fixture,
      });
      const stagingTrigger = await platform.getAutomationTrigger("cron-success", "staging");

      const nextTickRuns = await scheduler.pollOnce(requireDate(stagingTrigger.nextRunAt));
      expect(nextTickRuns).toMatchObject([
        { environment: "staging", automationName: "cron-success", status: "queued" },
      ]);
      expect(productionBatches).toBe(2);
    } finally {
      signal.removeEventListener("abort", onAbort);
      releaseBatch.resolve();
      try {
        await firstTick;
      } finally {
        await scheduler.close();
      }
    }
    expect(await firstTick).toHaveLength(2);
  });

  it("discovers environments on each pass and materializes each cron slot exactly once", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const environments = ["local"];
    const scheduler = await createSchedulerService({
      listEnvironments: async () => environments,
      platform,
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "packages/runtime/test-fixtures/cron-success"),
    });

    const trigger = await platform.getAutomationTrigger("cron-success", "local");
    const firstPollRuns = await scheduler.pollOnce(requireDate(trigger.nextRunAt));
    expect(firstPollRuns).toHaveLength(1);

    const duplicatePollRuns = await scheduler.pollOnce(requireDate(trigger.nextRunAt));
    expect(duplicatePollRuns).toHaveLength(0);

    // Process the first run so overlap-prevention does not skip the catchup slot.
    await platform.processNextPlatformRun();

    const updatedTrigger = await platform.getAutomationTrigger("cron-success", "local");
    const secondPollRuns = await scheduler.pollOnce(requireDate(updatedTrigger.nextRunAt));
    expect(secondPollRuns).toHaveLength(1);

    await platform.deployAutomationToPlatform({
      environment: "production",
      automationDirectory: path.join(repoRoot, "packages/runtime/test-fixtures/cron-success"),
    });
    environments.push("production");
    const productionTrigger = await platform.getAutomationTrigger("cron-success", "production");
    const productionRuns = await scheduler.pollOnce(requireDate(productionTrigger.nextRunAt));
    expect(productionRuns.map((run) => run.environment)).toEqual(["production"]);

    await scheduler.close();
  });

  it("names the environment of a failed pass and a failed check query", async () => {
    const platform = await testPlatform();
    await platform.deployAutomationToPlatform({
      environment: "staging",
      automationDirectory: path.join(repoRoot, "packages/runtime/test-fixtures/cron-success"),
    });
    const trigger = await platform.getAutomationTrigger("cron-success", "staging");
    const now = requireDate(trigger.nextRunAt);
    const cronError = new Error("cron unavailable");
    const checkError = new Error("checks unavailable");
    const cronPass = vi
      .spyOn(platform, "materializeDueCronRuns")
      .mockImplementation(async ({ environment }) => {
        if (environment === "staging") throw cronError;
        return [];
      });
    const checkPass = vi.spyOn(platform, "enqueueDueApiChecks").mockRejectedValue(checkError);
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const scheduler = await createSchedulerService({
      listEnvironments: async () => ["staging", "production"],
      platform,
      logger,
    });
    try {
      await expect(scheduler.pollOnce(now)).rejects.toThrow("Scheduler environment pass failed.");
      expect(logger.error).toHaveBeenCalledWith(
        { environment: "staging", err: cronError },
        "Scheduler environment pass failed.",
      );
      expect(logger.error).toHaveBeenCalledWith(
        { environment: "production", err: checkError },
        "Enqueueing due API checks failed.",
      );
      cronPass.mockRestore();
      checkPass.mockRestore();
      expect(await scheduler.pollOnce(now)).toMatchObject([
        { environment: "staging", automationName: "cron-success", status: "queued" },
      ]);
    } finally {
      await scheduler.close();
    }
  });

  it("skips cron slots when a previous run is still queued (on_overlap=skip)", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const scheduler = await createSchedulerService({
      listEnvironments: async () => ["local"],
      platform,
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "packages/runtime/test-fixtures/cron-success"),
    });

    const trigger = await platform.getAutomationTrigger("cron-success", "local");
    const firstPollRuns = await scheduler.pollOnce(requireDate(trigger.nextRunAt));
    expect(firstPollRuns).toHaveLength(1);

    const nextTrigger = await platform.getAutomationTrigger("cron-success", "local");
    const skippedRuns = await scheduler.pollOnce(requireDate(nextTrigger.nextRunAt));
    expect(skippedRuns).toHaveLength(0);

    expect(
      (await platform.listAutomationTriggerAuditEvents("cron-success", "local")).map(
        (event) => event.change,
      ),
    ).toContainEqual(
      expect.objectContaining({
        eventType: "cron_skipped",
        metadata: expect.objectContaining({ reason: "overlap" }),
      }),
    );

    await scheduler.close();
  });

  it("skips paused cron triggers until they are resumed", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const scheduler = await createSchedulerService({
      listEnvironments: async () => ["local"],
      platform,
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "packages/runtime/test-fixtures/cron-success"),
    });

    const trigger = await platform.getAutomationTrigger("cron-success", "local");
    await platform.pauseAutomationTrigger("cron-success", "local");

    const pausedRuns = await scheduler.pollOnce(requireDate(trigger.nextRunAt));
    expect(pausedRuns).toHaveLength(0);

    await platform.resumeAutomationTrigger("cron-success", "local");

    const resumedTrigger = await platform.getAutomationTrigger("cron-success", "local");
    const resumedRuns = await scheduler.pollOnce(requireDate(resumedTrigger.nextRunAt));
    expect(resumedRuns).toHaveLength(1);

    await scheduler.close();
  });

  it("records maintenance and queue samples in each served environment", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const scheduler = await createSchedulerService({
      listEnvironments: async () => ["staging", "production"],
      platform,
    });

    await scheduler.runMaintenanceOnce(new Date("2026-04-14T12:00:00.000Z"));

    for (const environment of ["staging", "production"]) {
      expect(await platform.getLatestMaintenanceRun(environment)).toMatchObject({
        environment,
        status: "succeeded",
      });
      expect(await platform.listQueueMetricSamples(environment)).toEqual([
        expect.objectContaining({ environment, queueName: "platform-runs" }),
      ]);
    }
    expect(await platform.getLatestMaintenanceRun("local")).toBeNull();

    await scheduler.close();
  });

  it("re-enqueues every queued run whose queue job is gone", async ({ signal }) => {
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const scheduler = await createSchedulerService({
      listEnvironments: async () => ["local"],
      platform,
      reconcileIntervalMs: 20,
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
    });
    const deployment = await platform.store.getActiveDeploymentBySlug("hello-webhook", "local");
    if (deployment === null) throw new Error("Expected an active deployment.");

    // Rows PostgreSQL holds while their BullMQ jobs are gone, as after a Valkey restart.
    const orphanedRunIds: string[] = [];
    for (let index = 0; index < 150; index += 1) {
      const runId = randomUUID();
      await platform.store.createRun({
        attemptsMax: 1,
        automationId: deployment.automationId,
        deploymentId: deployment.deploymentId,
        payload: { index },
        queueJobId: runId,
        queueName: createQueueNameForProfile(deployment.runtimeSnapshot.profile),
        runId,
        triggerType: "webhook",
        versionId: deployment.versionId,
      });
      orphanedRunIds.push(runId);
    }

    scheduler.start();
    const queueDepth = async () =>
      (await platform.runMaintenance({ environment: "local" })).queueSample.counts.waiting;
    await waitFor(signal, async () => (await queueDepth()) === orphanedRunIds.length);
    const processedRun = await platform.processNextPlatformRun();
    expect(processedRun?.status).toBe("succeeded");

    await scheduler.close();
  });

  it("records skipped cron slots when required secrets are missing", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const scheduler = await createSchedulerService({
      listEnvironments: async () => ["local"],
      platform,
    });

    // A deploy needs its secrets, so the slot is skipped once the bound secret is deleted.
    const place = { environment: "local", projectId: DEFAULT_PROJECT_ID };
    const secret = await platform.upsertSecret("CRON_REQUIRED_TOKEN", "token", place);
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(
        repoRoot,
        "packages/runtime/test-fixtures/cron-requires-secret",
      ),
    });
    await platform.deleteSecret(secret.id);

    const trigger = await platform.getAutomationTrigger("cron-requires-secret", "local");
    const runs = await scheduler.pollOnce(requireDate(trigger.nextRunAt));
    expect(runs).toHaveLength(0);

    const auditEvents = await platform.listAutomationTriggerAuditEvents(
      "cron-requires-secret",
      "local",
    );
    expect(auditEvents.map((event) => event.change)).toEqual([
      expect.objectContaining({
        eventType: "cron_skipped",
        metadata: expect.objectContaining({
          missingSecrets: ["CRON_REQUIRED_TOKEN"],
          reason: "missing-secrets",
        }),
      }),
    ]);

    await scheduler.close();
  });
});

function requireDate(value: string | null): Date {
  if (value === null) {
    throw new Error("Expected an ISO timestamp.");
  }

  return new Date(value);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
