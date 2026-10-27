import { expect, it } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { createAutomationFixture } from "../test/platform-harness.js";

it.each(["succeeded", "failed", "dead-lettered"] as const)(
  "keeps a %s run finished across late writes and cancellation",
  async (status) => {
    const platform = await testPlatform();
    await platform.deployAutomationToPlatform({
      automationDirectory: await createAutomationFixture({
        name: "terminal-guard",
        triggerLines: ["  type: webhook", "  path: /terminal-guard"],
      }),
      environment: "local",
    });
    const run = await platform.startManualRun({
      automationName: "terminal-guard",
      environment: "local",
      payload: {},
    });
    await platform.store.updateRunState({ runId: run.runId, status });
    await platform.store.updateRunState({ runId: run.runId, status: "queued" });
    expect(await platform.store.getRun(run.runId)).toMatchObject({ status });
    expect(await platform.cancelPlatformRun(run.runId)).toMatchObject({
      alreadyTerminal: true,
      run: { status },
    });
  },
);
