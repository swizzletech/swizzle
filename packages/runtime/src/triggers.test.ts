import type { ControlPlaneStore } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";

import { startManualRun } from "./triggers.js";

describe("startManualRun", () => {
  it("refuses a chain automation, which runs only when its sources succeed", async () => {
    const store = {
      getAutomationTriggerBySlug: vi.fn().mockResolvedValue({
        automationId: "automation-1",
        automationName: "hello-chain",
        deploymentId: "deployment-1",
        environment: "local",
        status: "active",
        triggerId: "trigger-1",
        triggerType: "chain",
      }),
    } as unknown as ControlPlaneStore;
    const enqueueRun = vi.fn();

    await expect(
      startManualRun({
        environment: "local",
        automationName: "hello-chain",
        enqueueRun,
        store,
      }),
    ).rejects.toMatchObject({
      code: "TRIGGER_NOT_FIRABLE",
      message: "Automation hello-chain runs when its chain sources succeed, not by hand.",
    });
    expect(enqueueRun).not.toHaveBeenCalled();
  });
});
