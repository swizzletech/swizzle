import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createAutomationFixture } from "../packages/runtime/test/platform-harness.js";
import { testPlatform } from "./platform.js";

it("uses its configured worker profile for queued runs and active checks", async () => {
  const platform = await testPlatform({ profiles: ["custom-group"] });
  const directory = await createAutomationFixture({
    name: "custom-worker",
    triggerLines: ["  type: webhook", "  path: /custom-worker"],
    configLines: [
      "runtime:",
      "  profile: custom-group",
      "api_check:",
      "  mode: active",
      "  entrypoint: check.js",
    ],
  });
  await writeFile(path.join(directory, "check.js"), "console.log(JSON.stringify({ ok: true }));");
  await platform.deployAutomationToPlatform({
    automationDirectory: directory,
    environment: "local",
  });
  const queued = await platform.startManualRun({
    automationName: "custom-worker",
    environment: "local",
    payload: {},
  });
  expect(await platform.processNextPlatformRun()).toMatchObject({
    runId: queued.runId,
    status: "succeeded",
    result: { ok: true },
  });
  const [check] = await platform.store.listDueAutomationChecks(new Date().toISOString(), "local");
  expect(check).toBeDefined();
  if (check === undefined) throw new Error("Expected an active check");
  expect(await platform.processPlatformCheck(check.checkId, check.nextCheckAt)).toMatchObject({
    status: "green",
    lastGreenReport: { ok: true },
  });
});
