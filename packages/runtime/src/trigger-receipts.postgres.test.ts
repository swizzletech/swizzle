import path from "node:path";
import { expect, it } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";

it("keeps trigger receipts in runs while the audit records trigger changes", async () => {
  const platform = await testPlatform({
    artifactsDirectory: path.join(await temporaryDirectory("swizzle-receipts-"), "artifacts"),
  });
  for (const [name, triggerLines] of [
    ["receipt-hook", ["  type: webhook", "  path: /receipt-hook"]],
    ["receipt-cron", ["  type: cron", "  every: 30s"]],
    ["receipt-chain", ["  type: chain", "  source: receipt-hook"]],
  ] as const) {
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: await createAutomationFixture({ name, triggerLines: [...triggerLines] }),
    });
  }
  const hook = await platform.triggerWebhookByPath({
    environment: "local",
    path: "/receipt-hook",
    payload: { delivered: true },
  });
  const runs = [await platform.processNextPlatformRun(), await platform.processNextPlatformRun()];
  const trigger = await platform.getAutomationTrigger("receipt-cron", "local");
  for (let tick = 0; tick < 10; tick++) {
    await platform.materializeDueCronRuns({
      environment: "local",
      now: new Date(Date.parse(trigger.nextRunAt ?? "") + tick * 30_000),
    });
    runs.push(await platform.processNextPlatformRun());
  }
  await platform.pauseAutomationTrigger("receipt-cron", "local");

  expect(runs.filter((run) => run?.triggerType === "cron")).toHaveLength(10);
  expect(runs.find((run) => run?.runId === hook.runId)).toMatchObject({
    payload: { delivered: true },
    triggerType: "webhook",
  });
  expect(runs.find((run) => run?.triggerType === "chain")).toMatchObject({
    chainSourceRunIds: [hook.runId],
    status: "succeeded",
  });
  const events = (
    await Promise.all(
      ["receipt-hook", "receipt-cron", "receipt-chain"].map((name) =>
        platform.listAutomationTriggerAuditEvents(name, "local"),
      ),
    )
  )
    .flat()
    .map((event) => event.change.eventType);
  expect(events).toContain("trigger_paused");
  expect(
    events.filter((type) =>
      ["cron_materialized", "webhook_received", "chain_triggered"].includes(type),
    ),
  ).toEqual([]);
});
