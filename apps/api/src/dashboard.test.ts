import { parseAutomationConfig } from "@swizzle/config";
import type { DashboardAutomationSummary, DashboardServiceHeartbeatView } from "@swizzle/db";
import type { ReadinessWorker } from "@swizzle/runtime";
import type {
  PlatformMaintenanceRunRecord,
  PlatformNotificationDeliveryRecord,
  PlatformServices,
} from "@swizzle/runtime/platform";
import { describe, expect, it, vi } from "vitest";

import { computeOperationsStateReasons, withReadiness } from "./dashboard.js";

const NOW = "2026-04-17T08:00:00.000Z";

function svc(
  overrides: Partial<DashboardServiceHeartbeatView> = {},
): DashboardServiceHeartbeatView {
  return {
    createdAt: NOW,
    environment: "local",
    host: "h",
    instanceId: "worker-1",
    metadata: {},
    observedAt: NOW,
    pid: 1,
    service: "scheduler",
    state: "alive",
    updatedAt: NOW,
    ...overrides,
  } as DashboardServiceHeartbeatView;
}

const EMPTY_QUEUE = {
  active: 0,
  completed: 0,
  delayed: 0,
  failed: 0,
  waiting: 0,
} as const;

const MAINTENANCE_OK: PlatformMaintenanceRunRecord = {
  createdAt: NOW,
  environment: "local",
  errorMessage: null,
  finishedAt: NOW,
  maintenanceRunId: "m1",
  startedAt: NOW,
  status: "succeeded",
  summary: {},
};

describe("computeOperationsStateReasons", () => {
  it("reports healthy when everything is green", () => {
    const result = computeOperationsStateReasons({
      deliveries: [],
      latestMaintenanceRun: MAINTENANCE_OK,
      observedAt: NOW,
      queueCounts: EMPTY_QUEUE,
      services: [svc()],
    });
    expect(result.stateReasons).toEqual([]);
    expect(result.maintenanceState).toBe("healthy");
  });

  it("does NOT alert on long-decommissioned stale services (outside window)", () => {
    const yesterday = "2026-04-16T08:00:00.000Z";
    const result = computeOperationsStateReasons({
      deliveries: [],
      latestMaintenanceRun: MAINTENANCE_OK,
      observedAt: NOW,
      queueCounts: EMPTY_QUEUE,
      services: [svc({ state: "stale", observedAt: yesterday, instanceId: "worker-ghost" })],
    });
    expect(result.stateReasons).not.toContain("stale-service-heartbeats");
  });

  it("alerts on stale services that went silent inside the window", () => {
    const recentlySilent = "2026-04-17T07:50:00.000Z";
    const result = computeOperationsStateReasons({
      deliveries: [],
      latestMaintenanceRun: MAINTENANCE_OK,
      observedAt: NOW,
      queueCounts: EMPTY_QUEUE,
      services: [svc({ state: "stale", observedAt: recentlySilent })],
    });
    expect(result.stateReasons).toContain("stale-service-heartbeats");
  });

  it("alerts on queue pressure from failed jobs alone", () => {
    const result = computeOperationsStateReasons({
      deliveries: [],
      latestMaintenanceRun: MAINTENANCE_OK,
      observedAt: NOW,
      queueCounts: { ...EMPTY_QUEUE, failed: 1 },
      services: [svc()],
    });
    expect(result.stateReasons).toContain("queue-pressure");
  });

  it("alerts on sustained waiting backlog (>= 10)", () => {
    const result = computeOperationsStateReasons({
      deliveries: [],
      latestMaintenanceRun: MAINTENANCE_OK,
      observedAt: NOW,
      queueCounts: { ...EMPTY_QUEUE, waiting: 10 },
      services: [svc()],
    });
    expect(result.stateReasons).toContain("queue-pressure");
  });

  it("does not alert on small backlogs", () => {
    const result = computeOperationsStateReasons({
      deliveries: [],
      latestMaintenanceRun: MAINTENANCE_OK,
      observedAt: NOW,
      queueCounts: { ...EMPTY_QUEUE, waiting: 9 },
      services: [svc()],
    });
    expect(result.stateReasons).not.toContain("queue-pressure");
  });

  it("alerts on any failed notification delivery", () => {
    const delivery = {
      status: "failed",
    } as PlatformNotificationDeliveryRecord;
    const result = computeOperationsStateReasons({
      deliveries: [delivery],
      latestMaintenanceRun: MAINTENANCE_OK,
      observedAt: NOW,
      queueCounts: EMPTY_QUEUE,
      services: [svc()],
    });
    expect(result.stateReasons).toContain("notification-delivery-failed");
  });

  it("surfaces missing maintenance runs", () => {
    const result = computeOperationsStateReasons({
      deliveries: [],
      latestMaintenanceRun: null,
      observedAt: NOW,
      queueCounts: EMPTY_QUEUE,
      services: [svc()],
    });
    expect(result.maintenanceState).toBe("missing");
    expect(result.stateReasons).toContain("maintenance-never-ran");
  });

  it("surfaces stale or failed maintenance runs", () => {
    const stale: PlatformMaintenanceRunRecord = {
      ...MAINTENANCE_OK,
      startedAt: "2026-04-17T07:00:00.000Z",
    };
    const result = computeOperationsStateReasons({
      deliveries: [],
      latestMaintenanceRun: stale,
      observedAt: NOW,
      queueCounts: EMPTY_QUEUE,
      services: [svc()],
    });
    expect(result.maintenanceState).toBe("degraded");
    expect(result.stateReasons).toContain("maintenance-stale-or-failed");
  });
});

describe("withReadiness", () => {
  const worker: ReadinessWorker = {
    availability: "online",
    capabilities: {
      binaries: [],
      dependencyPackaging: { node: true, python: true },
      executionModes: ["host", "container"],
      languages: [{ name: "node", version: "22.0.0" }],
    },
    concurrency: 1,
    instanceId: "worker-1",
    name: "test-host",
    profiles: [{ name: "host-default", queueName: "platform-runs--host-default" }],
    services: [],
  };
  const inspectImage: PlatformServices["runnerImageChecks"]["workers"] = async (
    _runtime,
    workers,
  ) => workers;
  const context = (grants: Record<string, number> = {}) => ({
    inspectImage,
    environment: "staging",
    grants: new Map(Object.entries(grants)),
    schedulerEnvironments: new Set(["staging"]),
    workers: [{ ...worker, projectIds: ["project-a"] }],
  });

  it("judges cron next runs and omits scheduler state from webhook triggers", async () => {
    const at = "2026-04-18T22:05:00.000Z";
    const cron = deployed("  language: node", {
      trigger: { triggerType: "cron", environment: "staging", nextRunAt: at },
    });
    expect((await withReadiness(cron, context())).trigger).toEqual({
      environment: "staging",
      nextRun: { kind: "at", at },
      triggerType: "cron",
    });
    expect(
      (await withReadiness(cron, { ...context(), schedulerEnvironments: new Set() })).trigger,
    ).toEqual({
      environment: "staging",
      nextRun: { kind: "unserved", environment: "staging" },
      triggerType: "cron",
    });
    expect(
      (
        await withReadiness(
          deployed("  language: node", { trigger: { triggerType: "webhook", nextRunAt: null } }),
          context(),
        )
      ).trigger,
    ).toEqual({ triggerType: "webhook" });
    expect((await withReadiness(deployed("  language: node"), context())).trigger).toBeNull();
  });

  it("filters list and detail readiness by the automation project", async () => {
    const a = deployed("  language: node");
    const b = deployed("  language: node", { projectId: "project-b" });
    expect((await withReadiness(a, context())).activeDeployment.readiness.status).toBe("ready");
    expect((await withReadiness(b, context())).activeDeployment.readiness.status).toBe("not-ready");
  });
  // The automation as the dashboard store lists it, its snapshot persisted from `runtime`.
  function deployed(runtime: string, overrides: Record<string, unknown> = {}) {
    const config = parseAutomationConfig(
      `name: demo\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\nruntime:\n${runtime}\n`,
    );
    return {
      activeDeployment: { runtimeSnapshot: config.runtime, sourceDirectory: "/nowhere" },
      projectId: "project-a",
      automationId: "automation-1",
      requiredConnections: [],
      requiredSecrets: [],
      trigger: null,
      ...overrides,
    } as unknown as DashboardAutomationSummary;
  }
  const readinessOf = async (
    automation: DashboardAutomationSummary,
    grants?: Record<string, number>,
  ) => {
    const { errors, status } = (await withReadiness(automation, context(grants))).activeDeployment
      .readiness;
    return { errors: errors.map(({ code, subject }) => ({ code, subject })), status };
  };

  it("judges the deployment's own container limits, not the default", async () => {
    vi.stubEnv("SWIZZLE_MAX_RUN_MEMORY_MB", "256");
    const container = (memory: number) =>
      `  language: node\n  execution_mode: container\n  container:\n    memory_mb: ${memory}`;

    expect(await readinessOf(deployed(container(64)))).toEqual({ errors: [], status: "ready" });
    expect(await readinessOf(deployed(container(1024)))).toEqual({
      errors: [
        { code: "RUNTIME_CONTAINER_LIMIT_EXCEEDS_MAX", subject: "runtime.container.memory_mb" },
      ],
      status: "not-ready",
    });
  });

  it("judges the deployment's own timeout against the ceiling and its grant", async () => {
    vi.stubEnv("SWIZZLE_MAX_RUN_TIMEOUT", "1h");
    const longRun = deployed("  language: node\n  timeout: 2h");

    expect(await readinessOf(longRun)).toEqual({
      errors: [{ code: "RUNTIME_TIMEOUT_EXCEEDS_MAX", subject: "runtime.timeout" }],
      status: "not-ready",
    });
    expect(await readinessOf(longRun, { "automation-1": 3 * 60 * 60_000 })).toEqual({
      errors: [],
      status: "ready",
    });
  });

  // Runs wait in the queue until a worker comes online, as deploy and `swizzle list` report it, so a
  // worker restart does not mark every automation blocked.
  it("keeps a registered sleeping worker group ready with a warning", async () => {
    const { status, warnings } = (
      await withReadiness(deployed("  language: node"), {
        ...context(),
        workers: context().workers.map((worker) => ({ ...worker, availability: "offline" })),
      })
    ).activeDeployment.readiness;

    expect(status).toBe("ready");
    expect(warnings.map(({ code }) => code)).toEqual(["RUNTIME_PROFILE_UNAVAILABLE"]);
  });

  it("is not ready while a declared secret is unset, and names it", async () => {
    const vault = deployed("  language: node", {
      requiredSecrets: [
        { name: "VERIFY_SECRET", state: "missing" },
        { name: "PRESENT_SECRET", state: "bound" },
      ],
    });

    const { errors, status } = (await withReadiness(vault, context())).activeDeployment.readiness;
    expect(status).toBe("not-ready");
    expect(errors).toEqual([
      {
        code: "SECRET_MISSING",
        message: "Secret VERIFY_SECRET is not set in staging. Set it and deploy again.",
        subject: "VERIFY_SECRET",
      },
    ]);
  });
});
