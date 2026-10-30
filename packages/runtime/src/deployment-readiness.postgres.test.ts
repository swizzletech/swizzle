import path from "node:path";
import {
  type DashboardStore,
  DEFAULT_PROJECT_ID,
  type WorkerRegistry,
  type WorkerStatus,
} from "@swizzle/db";
import { expect, it, vi } from "vitest";
import { testControlPlaneStore } from "../../../test/stores.js";
import { temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";

import { createPlatformServices } from "./platform-services.js";
import { collectWorkerCapabilities } from "./runtime-requirements.js";

it.each([false, true])(
  "uses one worker snapshot before deploy and rollback commits (skipReadinessCheck=%s)",
  async (skipReadinessCheck) => {
    const directory = await temporaryDirectory("swizzle-deploy-readiness-");
    const worker: WorkerStatus = {
      id: "readiness-worker",
      kind: "remote",
      name: "test worker",
      capacity: 1,
      draining: false,
      services: [],
      profiles: ["host-default"],
      environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "local" }],
      state: "online",
      credentialGeneration: 1,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      tokenExpiresAt: null,
      slotsInUse: 0,
      currentRuns: [],
      localLlm: null,
      runImageDisk: null,
      capabilities: await collectWorkerCapabilities([]),
      runImageDiskOverBudget: null,
    };
    const list = vi.fn<WorkerRegistry["list"]>();
    const unused = async (): Promise<never> => {
      throw new Error("unexpected dashboard operation");
    };
    const dashboardStore: DashboardStore = {
      close: vi.fn(async () => {}),
      countRunsSince: unused,
      countStepReach: unused,
      listDeploymentChanges: unused,
      listServiceHeartbeats: unused,
      getAutomationDetail: unused,
      getMermaidDiagram: unused,
      listAutomationSummaries: unused,
      listRuns: unused,
      listQueuedRuns: unused,
      listRunSteps: unused,
      upsertServiceHeartbeat: unused,
    };
    const store = testControlPlaneStore();
    const platform = await createPlatformServices({
      artifactsDirectory: path.join(directory, "artifacts"),
      store,
      dashboardStore,
      workerRegistry: { close: async () => {}, list, placement: unused },
    });
    try {
      const automationDirectory = await createAutomationFixture({
        name: "readiness-probe",
        triggerLines: ["  type: webhook", "  path: /readiness-probe"],
      });
      list
        .mockResolvedValueOnce([worker])
        .mockRejectedValue(new Error("second worker read failed"));
      const deployed = await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory,
        skipReadinessCheck,
      });
      expect(deployed.readiness.status).toBe("ready");
      expect(list).toHaveBeenCalledTimes(1);
      await expect(
        platform.rollbackDeployment({
          automationName: "readiness-probe",
          environment: "local",
          targetDeploymentId: deployed.deploymentId,
        }),
      ).rejects.toThrow("second worker read failed");
      expect(
        (await store.listDeploymentsByAutomationSlug("readiness-probe", "local")).map(
          (deployment) => deployment.deploymentId,
        ),
      ).toEqual([deployed.deploymentId]);

      list.mockResolvedValueOnce([worker]);
      const rolledBack = await platform.rollbackDeployment({
        automationName: "readiness-probe",
        environment: "local",
        targetDeploymentId: deployed.deploymentId,
      });
      expect(rolledBack.readiness.status).toBe("ready");
      expect(rolledBack.seq).toBe(2);
      expect(
        (await store.getActiveDeploymentBySlug("readiness-probe", "local"))?.deploymentId,
      ).toBe(rolledBack.deploymentId);

      list.mockRejectedValue(new Error("worker read failed"));
      await expect(
        platform.deployAutomationToPlatform({
          environment: "local",
          automationDirectory,
          force: true,
        }),
      ).rejects.toThrow("worker read failed");
      expect(
        (await store.listDeploymentsByAutomationSlug("readiness-probe", "local")).map(
          (deployment) => deployment.deploymentId,
        ),
      ).toEqual([rolledBack.deploymentId, deployed.deploymentId]);
    } finally {
      await platform.close();
    }
    expect(dashboardStore.close).not.toHaveBeenCalled();
  },
);

it("deploys against a custom image's record instead of the default worker inventory", async ({
  signal,
}) => {
  const { createDashboardStore } = await import("@swizzle/db/postgres");
  const { testDatabase } = await import("../../../test/postgres.js");
  const { waitFor } = await import("../../../test/support.js");
  const directory = await temporaryDirectory("swizzle-custom-readiness-");
  const capabilities = {
    binaries: [{ name: "default-only", version: "9" }],
    languages: [{ name: "node", version: "26.12.1" }],
    executionModes: ["container"],
    dependencyPackaging: { node: true, python: false },
  } satisfies WorkerStatus["capabilities"];
  const worker: WorkerStatus = {
    id: "readiness-worker",
    kind: "local",
    name: "Local worker",
    capacity: 1,
    draining: false,
    services: [],
    profiles: ["host-default"],
    environments: "all",
    state: "online",
    credentialGeneration: 1,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    tokenExpiresAt: null,
    slotsInUse: 0,
    currentRuns: [],
    localLlm: null,
    runImageDisk: null,
    runImageDiskOverBudget: null,
    capabilities,
  };
  const dashboardStore = createDashboardStore({ client: testDatabase() });
  const platform = await createPlatformServices({
    artifactsDirectory: path.join(directory, "artifacts"),
    store: testControlPlaneStore(),
    dashboardStore,
    workerRegistry: {
      close: async () => {},
      list: async () => [worker],
      placement: async () => {
        throw new Error("Unexpected placement during readiness check.");
      },
    },
  });
  try {
    const automationDirectory = await createAutomationFixture({
      name: "custom-readiness",
      triggerLines: ["  type: webhook", "  path: /hooks/custom-readiness"],
      configLines: [
        "runtime:",
        "  execution_mode: container",
        "  container: { base_image: custom:reviewed }",
        "  requirements:",
        '    binaries: [{ name: image-only, version: ">=7" }]',
      ],
    });
    let finished = false;
    const deployment = platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
    });
    const result = deployment.then(
      (value) => {
        finished = true;
        return value;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    let requests: ReturnType<typeof platform.runnerImageChecks.exchange> = [];
    await waitFor(signal, () => {
      requests = platform.runnerImageChecks?.exchange(worker.id, []) ?? [];
      return finished || requests.length > 0;
    });
    for (const request of requests)
      platform.runnerImageChecks.exchange(worker.id, [
        {
          id: request.id,
          result: {
            kind: "ready",
            capabilities: { ...capabilities, binaries: [{ name: "image-only", version: "7.2" }] },
          },
        },
      ]);
    expect(await result).toMatchObject({ readiness: { status: "ready" } });
  } finally {
    await platform.close();
  }
});
