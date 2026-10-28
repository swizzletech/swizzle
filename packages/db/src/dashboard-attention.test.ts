import { describe, expect, it } from "vitest";
import type { StoredMaintenanceRun as PlatformMaintenanceRunRecord } from "./control-plane-types.js";
import { buildAttention } from "./dashboard-attention.js";
import type { DashboardAutomationSummary, DashboardRunGlance } from "./dashboard-types.js";
import type { RunPlacement } from "./workers.js";

const NOW = "2026-04-17T08:00:00.000Z";
const EMPTY_QUEUE = { active: 0, completed: 0, delayed: 0, failed: 0, waiting: 0 } as const;
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
describe("buildAttention", () => {
  const local = { name: "Local worker", state: "online", runImageDiskOverBudget: null } as const;
  const base = {
    approvals: [],
    deliveries: [],
    environment: "local",
    schedulerEnvironments: new Set(["local"]),
    latestMaintenanceRun: MAINTENANCE_OK,
    observedAt: new Date(NOW),
    queueCounts: EMPTY_QUEUE,
    queued: [],
    workers: [local],
  };

  function automation(
    slug: string,
    overrides: Partial<DashboardAutomationSummary> = {},
  ): DashboardAutomationSummary {
    return {
      activeDeployment: null,
      apiCheck: null,
      apiContacts: [],
      automationId: slug,
      automationName: slug,
      automationSlug: slug,
      description: null,
      environment: "local",
      folderId: null,
      folderName: null,
      lastRun: null,
      projectId: "default",
      project: { id: "default", slug: "default", name: "Default" },
      recentRuns: [],
      requiredConnections: [],
      requiredSecrets: [],
      trigger: null,
      ...overrides,
    } as DashboardAutomationSummary;
  }
  const glance = (runId: string, status: DashboardRunGlance["status"]): DashboardRunGlance => ({
    errorCode: null,
    errorMessage: status === "failed" ? "Automation exited with code 1." : null,
    queuedAt: NOW,
    runId,
    status,
    triggerType: "manual",
  });
  const missing = (name: string) =>
    ({ name, state: "missing" }) as DashboardAutomationSummary["requiredSecrets"][number];

  it("lists nothing on an instance without automations, even with the platform down", () => {
    expect(
      buildAttention({
        ...base,
        automations: [],
        schedulerEnvironments: new Set(),
        latestMaintenanceRun: null,
        workers: [],
      }),
    ).toEqual([]);
  });

  // The Overview passes only the automations its reader may edit, so a viewer's list can be empty
  // while an approval assigned to them waits.
  it("keeps an approval when no automation raises a row of its own", () => {
    const approval = {
      assignee: null,
      automation: { automationName: "a", automationSlug: "a" },
      details: null,
      runId: "run",
      stepKey: "ok",
      waitingSince: NOW,
      waitUntil: null,
    };
    expect(buildAttention({ ...base, approvals: [approval], automations: [] })).toEqual([
      { kind: "approval", ...approval },
    ]);
  });

  it("orders approvals first, groups a missing secret, and never counts waiting as failing", () => {
    const items = buildAttention({
      ...base,
      approvals: [
        {
          assignee: null,
          automation: { automationName: "b", automationSlug: "b" },
          details: null,
          runId: "late",
          stepKey: "ok",
          waitingSince: "2026-04-17T07:30:00.000Z",
          waitUntil: null,
        },
        {
          assignee: null,
          automation: { automationName: "a", automationSlug: "a" },
          details: { amount: 12 },
          runId: "early",
          stepKey: "ok",
          waitingSince: "2026-04-17T07:00:00.000Z",
          waitUntil: null,
        },
      ],
      automations: [
        automation("probe", {
          recentRuns: [
            glance("r4", "waiting"),
            glance("r3", "dead-lettered"),
            glance("r2", "succeeded"),
            glance("r1", "failed"),
          ],
          requiredSecrets: [missing("API_KEY")],
        }),
        automation("waiter", {
          recentRuns: [glance("w1", "waiting")],
          requiredSecrets: [missing("API_KEY")],
        }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual([
      "approval",
      "approval",
      "failing",
      "missing-secret",
    ]);
    expect(items[0]).toMatchObject({ runId: "early" });
    expect(items[2]).toMatchObject({ failedRuns: 2, lastFailedRunId: "r3", recentRuns: 4 });
    expect(items[3]).toEqual({
      kind: "missing-secret",
      project: { id: "default", slug: "default", name: "Default" },
      secretName: "API_KEY",
      state: "missing",
      usedBy: [
        { automationName: "probe", automationSlug: "probe" },
        { automationName: "waiter", automationSlug: "waiter" },
      ],
    });
  });

  it("lists API drift, then near sunsets, then untested passive APIs, but not a passing doubt", () => {
    const record = (
      status: "drift" | "error" | "green",
      consecutiveFailures: number,
      lastOutput: string | null,
    ) => ({
      consecutiveFailures,
      deploymentId: "d1",
      failingSince: NOW,
      lastCheckedAt: NOW,
      lastExitCode: { drift: 1, error: 2, green: 0 }[status],
      lastGreenAt: null,
      lastGreenOutput: null,
      lastGreenReport: null,
      lastOutput,
      lastReport: {
        change:
          status === "drift"
            ? { api: null, expected: "number", field: "amount", got: "string" }
            : null,
        checked: status === "green" ? ["GET /v1/deals"] : [],
        ok: status === "green",
      },
      lastStderrTail: null,
      lastWarning: null,
      nextCheckAt: NOW,
      status,
    });
    const active = (check: ReturnType<typeof record>) =>
      ({
        entrypoint: "check.ts",
        everyMs: 7 * 86_400_000,
        mode: "active",
        record: check,
        secrets: null,
      }) as const;
    const contact = (host: string, sunsetAt: string, noticeSeenAt: string) => ({
      deprecatedAt: null,
      host,
      lastContactAt: noticeSeenAt,
      lastOkAt: noticeSeenAt,
      lastStatus: 200,
      noticePath: "/v1/deals",
      noticeRuns: 3,
      noticeSeenAt,
      noticeUrl: null,
      sunsetAt,
    });

    const items = buildAttention({
      ...base,
      automations: [
        automation("quiet", {
          activeDeployment: { deployedAt: "2026-03-01T08:00:00.000Z" },
          apiCheck: { mode: "passive", untestedAfterMs: 30 * 86_400_000 },
        } as Partial<DashboardAutomationSummary>),
        automation("drifting", {
          apiCheck: active(record("drift", 1, "diagnostic text, not the report")),
        }),
        automation("flaky", { apiCheck: active(record("error", 2, null)) }),
        automation("passing", {
          apiCheck: active(record("green", 0, '{"ok":true,"checked":["GET /v1/deals"]}')),
        }),
        automation("sunsetting", {
          apiCheck: { mode: "off", reason: "paid per call" },
          apiContacts: [
            contact("api.near.example", "2026-06-30T00:00:00.000Z", "2026-04-16T08:00:00.000Z"),
            contact("api.far.example", "2027-06-30T00:00:00.000Z", "2026-04-16T08:00:00.000Z"),
            contact("api.stale.example", "2026-06-30T00:00:00.000Z", "2026-04-01T08:00:00.000Z"),
          ],
        }),
      ],
    });

    expect(items).toMatchObject([
      {
        automation: { automationSlug: "drifting" },
        change: { api: null, expected: "number", field: "amount", got: "string" },
        kind: "api-check",
      },
      {
        automation: { automationSlug: "sunsetting" },
        contact: { host: "api.near.example" },
        kind: "api-sunset",
      },
      {
        automation: { automationSlug: "quiet" },
        host: null,
        kind: "api-untested",
        since: "2026-03-01T08:00:00.000Z",
      },
    ]);
  });

  it("names a missing worker with the runs it strands instead of a backlog", () => {
    const items = buildAttention({
      ...base,
      automations: [automation("probe")],
      queueCounts: { ...EMPTY_QUEUE, waiting: 14 },
      workers: [{ ...local, state: "offline" }],
    });

    expect(items).toEqual([{ kind: "platform", problem: { code: "no-worker", queuedRuns: 14 } }]);
  });

  it("lists queued runs no worker can take, with the reason, and not a busy group's", () => {
    const queued = (wait: RunPlacement["wait"]) => ({
      automation: { automationName: "Build", automationSlug: "build" },
      runId: `run-${wait}`,
      queued: 2,
      deadline: "2026-04-18T08:00:00.000Z",
      queueTimeout: "24h",
      projectId: "project-a",
      environment: "local",
      profile: "build-box",
      services: [],
      placement: {
        group: "build-box",
        services: [],
        wait,
        deadline: "2026-04-18T08:00:00.000Z",
        queueTimeout: "24h",
        workers: [],
      },
    });
    // A run stays in its project when its automation moves, so its project lists no automation.
    const items = buildAttention({
      ...base,
      automations: [],
      queued: [queued("offline"), queued("busy")],
    });

    expect(items).toEqual([
      {
        automation: { automationName: "Build", automationSlug: "build" },
        deadline: "2026-04-18T08:00:00.000Z",
        group: "build-box",
        kind: "waiting-for-worker",
        queuedRuns: 2,
        reason:
          'Every worker granted group "build-box" is offline, draining or not enrolled yet; the run starts when one comes online.',
        runId: "run-offline",
      },
    ]);
  });

  // A stack's one scheduler serves the environment in its .env; one in another environment is
  // running, but not for this one.
  it("names the environment no scheduler serves, and the ones a scheduler does", () => {
    const items = buildAttention({
      ...base,
      automations: [automation("probe")],
      environment: "production",
      schedulerEnvironments: new Set(["staging"]),
    });

    expect(items).toEqual([
      {
        kind: "platform",
        problem: { code: "scheduler-down", environment: "production", served: ["staging"] },
      },
    ]);
  });

  it("says the queue does not answer instead of failing the whole Overview", () => {
    const items = buildAttention({
      ...base,
      automations: [automation("probe")],
      queueCounts: null,
    });

    expect(items).toEqual([{ kind: "platform", problem: { code: "queue-unreachable" } }]);
  });

  it("lists each worker whose active run images pass its disk budget", () => {
    const disk = {
      activeBytes: 3 * 1024 * 1_048_576,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 1024 * 1_048_576,
    };
    const items = buildAttention({
      ...base,
      automations: [automation("probe")],
      workers: [{ name: "gpu-home", state: "online", runImageDiskOverBudget: disk }, local],
    });

    expect(items).toEqual([
      {
        kind: "platform",
        problem: {
          code: "run-image-disk",
          worker: "gpu-home",
          warning: {
            title:
              "gpu-home keeps 3.0 GiB of run images for active deployments, more than its disk budget of 1.0 GiB. Swizzle keeps them so those deployments keep running.",
            todo: "Remove deployments this worker runs, or raise SWIZZLE_RUNNER_IMAGE_DISK_MB on it and restart it.",
          },
        },
      },
    ]);
  });
});
