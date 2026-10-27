import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { temporaryDirectory } from "../../../test/support.js";

const queueMock = vi.hoisted(() => ({
  cleanCalls: [] as {
    gracePeriodMs: number;
    limit: number;
    queueName: string;
    status: string;
  }[],
  closedQueues: [] as string[],
  counts: new Map<
    string,
    {
      active: number;
      completed: number;
      delayed: number;
      failed: number;
      waiting: number;
    }
  >(),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    readonly name: string;

    constructor(name: string) {
      this.name = name;
    }

    async clean(gracePeriodMs: number, limit: number, status: string) {
      queueMock.cleanCalls.push({ gracePeriodMs, limit, queueName: this.name, status });
      const counts = queueMock.counts.get(this.name);
      const removed = Array.from({ length: counts?.failed ?? 0 }, (_, index) => `${index}`);
      if (counts) {
        queueMock.counts.set(this.name, { ...counts, failed: 0 });
      }
      return removed;
    }

    async close() {
      queueMock.closedQueues.push(this.name);
    }

    async getJobCounts() {
      return queueMock.counts.get(this.name);
    }
  },
}));

import {
  resolveMaintenanceQueueNames,
  resolveMaintenanceRetentionPolicy,
  runMaintenanceCycle,
} from "./maintenance.js";

const helloWebhook = fileURLToPath(
  new URL("../../../infra/examples/hello-webhook", import.meta.url),
);

const EMPTY_QUEUE_COUNTS = {
  active: 0,
  completed: 0,
  delayed: 0,
  failed: 0,
  waiting: 0,
} as const;

beforeEach(() => {
  queueMock.cleanCalls.length = 0;
  queueMock.closedQueues.length = 0;
  queueMock.counts.clear();
});

describe("resolveMaintenanceQueueNames", () => {
  it("always includes the default worker profile queue", () => {
    expect(resolveMaintenanceQueueNames([])).toEqual(["platform-runs--host-default"]);
  });

  it("includes every unique queue used by deployed runtime profiles", () => {
    const deployments = [
      { runtimeSnapshot: { profile: "host-default" } },
      { runtimeSnapshot: { profile: "gpu" } },
      { runtimeSnapshot: { profile: "OCR: Tools / EU" } },
      { runtimeSnapshot: { profile: "gpu" } },
    ];

    expect(resolveMaintenanceQueueNames(deployments)).toEqual([
      "platform-runs--host-default",
      "platform-runs--gpu",
      "platform-runs--ocr-tools-eu",
    ]);
  });

  it("preserves an explicit queue override", () => {
    expect(
      resolveMaintenanceQueueNames([{ runtimeSnapshot: { profile: "gpu" } }], "platform-runs:test"),
    ).toEqual(["platform-runs:test"]);
  });
});

describe("runMaintenanceCycle", () => {
  it("cleans every deployed profile queue and records aggregate counts", async () => {
    queueMock.counts.set("platform-runs--host-default", {
      ...EMPTY_QUEUE_COUNTS,
      completed: 3,
      failed: 2,
    });
    queueMock.counts.set("platform-runs--gpu", {
      ...EMPTY_QUEUE_COUNTS,
      failed: 1,
      waiting: 4,
    });
    const stateDirectory = await temporaryDirectory("swizzle-maintenance-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const gpuDirectory = path.join(stateDirectory, "gpu-job");
    await cp(helloWebhook, gpuDirectory, { recursive: true });
    const config = await readFile(path.join(gpuDirectory, "config.yaml"), "utf8");
    await writeFile(
      path.join(gpuDirectory, "config.yaml"),
      config
        .replace("name: hello-webhook", "name: gpu-job")
        .replace("path: /hello", "path: /gpu")
        .replace("profile: host-default", "profile: gpu"),
    );
    // Maintenance reads only the stored profiles, so the deploys skip host capability probes.
    await platform.deployAutomationToPlatform({
      environment: "production",
      automationDirectory: helloWebhook,
      skipReadinessCheck: true,
    });
    await platform.deployAutomationToPlatform({
      environment: "production",
      automationDirectory: gpuDirectory,
      skipReadinessCheck: true,
    });

    await runMaintenanceCycle({
      environment: "production",
      now: new Date("2026-07-17T22:00:00.000Z"),
      retention: {
        artifactRetentionDeployments: null,
        queueFailedRetentionHours: 24,
        runRetentionDays: null,
      },
      store: platform.store,
    });

    expect(queueMock.cleanCalls).toEqual([
      {
        gracePeriodMs: 86_400_000,
        limit: 10_000,
        queueName: "platform-runs--host-default",
        status: "failed",
      },
      {
        gracePeriodMs: 86_400_000,
        limit: 10_000,
        queueName: "platform-runs--gpu",
        status: "failed",
      },
    ]);
    expect(await platform.store.listQueueMetricSamples({ environment: "production" })).toEqual([
      {
        counts: {
          ...EMPTY_QUEUE_COUNTS,
          completed: 3,
          waiting: 4,
        },
        environment: "production",
        observedAt: "2026-07-17T22:00:00.000Z",
        queueName: "platform-runs",
        sampleId: expect.any(String),
      },
    ]);
    expect(queueMock.closedQueues).toEqual(["platform-runs--host-default", "platform-runs--gpu"]);
  });

  it("expires a finished run past the retention age and keeps an unfinished one", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-maintenance-expiry-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    await platform.deployAutomationToPlatform({
      automationDirectory: helloWebhook,
      environment: "local",
    });
    const trigger = () =>
      platform.triggerWebhookByPath({ environment: "local", path: "/hello", payload: {} });
    const finished = await trigger();
    await platform.processNextPlatformRun();
    const queued = await trigger();

    const result = await runMaintenanceCycle({
      environment: "local",
      now: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
      queueCounts: EMPTY_QUEUE_COUNTS,
      retention: { artifactRetentionDeployments: null, runRetentionDays: 30 },
      store: platform.store,
    });

    expect(result.runExpiry).toEqual({ runsDeleted: 1 });
    expect(await platform.store.getRun(finished.runId)).toBeNull();
    expect((await platform.store.getRun(queued.runId))?.status).toBe("queued");
  });
});

describe("resolveMaintenanceRetentionPolicy", () => {
  it("keeps finished runs 30 days unless told otherwise", () => {
    expect(resolveMaintenanceRetentionPolicy({}).runRetentionDays).toBe(30);
    expect(
      resolveMaintenanceRetentionPolicy({ SWIZZLE_RUN_RETENTION_DAYS: "60" }).runRetentionDays,
    ).toBe(60);
  });

  it.each(["0", "off"])("allows %s to keep runs forever", (value) => {
    expect(
      resolveMaintenanceRetentionPolicy({ SWIZZLE_RUN_RETENTION_DAYS: value }).runRetentionDays,
    ).toBeNull();
  });

  it.each(["0", "off"])("allows %s to disable artifact sweeping", (value) => {
    const retention = resolveMaintenanceRetentionPolicy({
      SWIZZLE_ARTIFACT_RETENTION_DEPLOYMENTS: value,
    });

    expect(retention.artifactRetentionDeployments).toBeNull();
  });

  it("keeps explicit non-negative artifact retention values", () => {
    const retention = resolveMaintenanceRetentionPolicy({
      SWIZZLE_ARTIFACT_RETENTION_DEPLOYMENTS: "2",
    });

    expect(retention.artifactRetentionDeployments).toBe(2);
  });
});
