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
