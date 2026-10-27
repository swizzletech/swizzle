import { randomUUID } from "node:crypto";
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
  it("materializes due cron runs exactly once per slot", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const scheduler = await createSchedulerService({ environmentName: "local", platform });

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

    await scheduler.close();
  });

  it("skips cron slots when a previous run is still queued (on_overlap=skip)", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const scheduler = await createSchedulerService({ environmentName: "local", platform });

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
    const scheduler = await createSchedulerService({ environmentName: "local", platform });

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

  it("records maintenance runs and queue samples for the configured environment only", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const scheduler = await createSchedulerService({ environmentName: "prod", platform });

    await scheduler.runMaintenanceOnce(new Date("2026-04-14T12:00:00.000Z"));

    const latestMaintenanceRun = await platform.getLatestMaintenanceRun("prod");
    expect(latestMaintenanceRun).toMatchObject({
      environment: "prod",
      status: "succeeded",
    });

    expect(await platform.getLatestMaintenanceRun("local")).toBeNull();
    expect(await platform.listQueueMetricSamples("prod")).toEqual([
      expect.objectContaining({ environment: "prod", queueName: "platform-runs" }),
    ]);

    await scheduler.close();
  });

  it("re-enqueues every queued run whose queue job is gone", async ({ signal }) => {
    const stateDirectory = await temporaryDirectory("swizzle-scheduler-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const scheduler = await createSchedulerService({
      environmentName: "local",
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
    const scheduler = await createSchedulerService({ environmentName: "local", platform });

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
