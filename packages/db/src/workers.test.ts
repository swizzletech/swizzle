import { expect, it } from "vitest";
import {
  explainPlacement,
  runImageDiskOverBudget,
  type WorkerStatus,
  workerGroups,
} from "./workers.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function worker(overrides: Partial<WorkerStatus>): WorkerStatus {
  return {
    id: "w",
    name: "gpu-box",
    kind: "remote",
    profiles: ["gpu-home"],
    services: [],
    environments: [{ projectId: PROJECT, environment: "production" }],
    capacity: 1,
    draining: false,
    credentialGeneration: 1,
    state: "online",
    lastSeenAt: "2026-10-25T08:00:00.000Z",
    createdAt: "2026-10-01T08:00:00.000Z",
    tokenExpiresAt: "2027-01-01T08:00:00.000Z",
    runImageDisk: null,
    capabilities: null,
    runImageDiskOverBudget: null,
    slotsInUse: 0,
    currentRuns: [],
    localLlm: null,
    ...overrides,
  };
}

const target = {
  projectId: PROJECT,
  environment: "production",
  profile: "gpu-home",
  services: [] as "local-llm"[],
  queueTimeout: "24h",
  deadline: new Date("2026-10-26T08:00:00.000Z"),
};

it("names why a pinned run waits, by the claim rules", () => {
  const wait = (workers: readonly WorkerStatus[], services: "local-llm"[] = []) =>
    explainPlacement({ ...target, services }, workers).wait;

  expect(wait([])).toBe("no-worker");
  expect(wait([worker({ profiles: ["host-default"] })])).toBe("no-worker");
  expect(wait([worker({ environments: [{ projectId: OTHER, environment: "production" }] })])).toBe(
    "no-worker",
  );
  expect(wait([worker({ state: "revoked" })])).toBe("no-worker");
  expect(wait([worker({})], ["local-llm"])).toBe("no-worker");
  expect(wait([worker({ state: "offline" })])).toBe("offline");
  expect(wait([worker({ state: "pending" })])).toBe("offline");
  expect(wait([worker({ draining: true })])).toBe("offline");
  expect(wait([worker({ services: ["local-llm"], localLlm: "unhealthy" })], ["local-llm"])).toBe(
    "service-unhealthy",
  );
  expect(wait([worker({ slotsInUse: 1 })])).toBe("busy");
  expect(wait([worker({ slotsInUse: 1 }), worker({ name: "second", slotsInUse: 0 })])).toBe(
    "ready",
  );
  expect(wait([worker({ services: ["local-llm"], localLlm: "healthy" })], ["local-llm"])).toBe(
    "ready",
  );
  expect(wait([worker({ kind: "local", environments: "all" })])).toBe("ready");
});

it("tells each machine's own reason when a group's machines differ", () => {
  const placement = explainPlacement({ ...target, services: ["local-llm"] }, [
    worker({ name: "full", services: ["local-llm"], localLlm: "healthy", slotsInUse: 1 }),
    worker({ name: "idle", services: ["local-llm"], localLlm: "unhealthy" }),
    worker({ name: "asleep", services: ["local-llm"], state: "offline" }),
  ]);

  expect(placement.wait).toBe("busy");
  expect(placement.workers.map(({ name, wait }) => ({ name, wait }))).toEqual([
    { name: "full", wait: "busy" },
    { name: "idle", wait: "service-unhealthy" },
    { name: "asleep", wait: "offline" },
  ]);
});

it("says until when and which machines could take the run, without their ids", () => {
  const placement = explainPlacement(target, [
    worker({ state: "offline", lastSeenAt: "2026-10-25T06:00:00.000Z" }),
    worker({ name: "laptop", profiles: ["host-default"] }),
  ]);

  expect(placement).toEqual({
    group: "gpu-home",
    services: [],
    wait: "offline",
    deadline: "2026-10-26T08:00:00.000Z",
    queueTimeout: "24h",
    workers: [
      {
        name: "gpu-box",
        kind: "remote",
        state: "offline",
        draining: false,
        lastSeenAt: "2026-10-25T06:00:00.000Z",
        services: [],
        localLlm: null,
        wait: "offline",
      },
    ],
  });
});

it("lists the groups that serve one project and environment", () => {
  const groups = workerGroups({ projectId: PROJECT, environment: "production" }, [
    worker({
      name: "Local worker",
      kind: "local",
      profiles: ["host-default"],
      environments: "all",
    }),
    worker({ name: "gpu-box", profiles: ["gpu-home", "batch"], services: ["local-llm"] }),
    worker({ name: "elsewhere", environments: [{ projectId: OTHER, environment: "production" }] }),
    worker({
      name: "staging-only",
      environments: [{ projectId: PROJECT, environment: "staging" }],
    }),
    worker({ name: "old", state: "revoked" }),
  ]);

  expect(
    groups.map((group) => ({ name: group.name, workers: group.workers.map((w) => w.name) })),
  ).toEqual([
    { name: "batch", workers: ["gpu-box"] },
    { name: "gpu-home", workers: ["gpu-box"] },
    { name: "host-default", workers: ["Local worker"] },
  ]);
});

it("warns about run images only when an unrevoked worker's active images pass its budget", () => {
  const over = { activeBytes: 3 * 1_048_576, budgetBytes: 1_048_576 };
  expect(runImageDiskOverBudget(worker({ runImageDisk: over }))).toEqual(over);
  expect(
    runImageDiskOverBudget(worker({ runImageDisk: { ...over, activeBytes: 1_048_576 } })),
  ).toBeNull();
  expect(runImageDiskOverBudget(worker({ runImageDisk: null }))).toBeNull();
  expect(runImageDiskOverBudget(worker({ runImageDisk: over, state: "revoked" }))).toBeNull();
});
