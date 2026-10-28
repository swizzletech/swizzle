import { describe, expect, it } from "vitest";

import type { TriggerSummary } from "../api";
import { nextRunInWords, triggerInWords } from "./triggers";

const NOW = new Date("2026-10-23T12:00:00.000Z");

function trigger(
  overrides: Partial<TriggerSummary> & {
    nextRun?: Extract<TriggerSummary, { triggerType: "cron" }>["nextRun"];
  },
): TriggerSummary {
  const { nextRun = null, ...summary } = overrides;
  const base: Omit<TriggerSummary, "triggerType"> = {
    chainOnStatus: null,
    chainHiddenSourceCount: 0,
    chainPayloadMode: null,
    chainSourceAutomationNames: [],
    chainSourceAutomationSlugs: [],
    cronIntervalMs: null,
    cronSchedule: null,
    deploymentId: "d",
    environment: "staging",
    errorCode: null,
    errorMessage: null,
    pausedAt: null,
    status: "active",
    triggerId: "t",
    updatedAt: NOW.toISOString(),
    versionId: "v",
    webhookPath: "/hello",
    webhookUrl: "http://127.0.0.1:19826/hello?environment=staging",
    ...summary,
  };
  return overrides.triggerType === "cron"
    ? { ...base, triggerType: "cron", nextRun }
    : { ...base, triggerType: overrides.triggerType ?? "webhook" };
}

describe("triggerInWords", () => {
  it.each([
    [
      trigger({
        triggerType: "chain",
        status: "invalid",
        errorCode: "TRIGGER_CHAIN_SOURCE_DELETED",
      }),
      "Chain source deleted",
    ],
    [trigger({}), "Webhook `/hello`"],
    [trigger({ cronIntervalMs: 30_000, triggerType: "cron" }), "Every 30 seconds"],
    [trigger({ cronIntervalMs: 3_600_000, triggerType: "cron" }), "Every hour"],
    [trigger({ cronIntervalMs: 9_000_000, triggerType: "cron" }), "Every 2h30m"],
    [trigger({ cronSchedule: "0 9 * * 1", triggerType: "cron" }), "Mondays 09:00 UTC"],
    [trigger({ cronSchedule: "30 6 * * *", triggerType: "cron" }), "Daily 06:30 UTC"],
    [trigger({ cronSchedule: "0 0 1 * *", triggerType: "cron" }), "Cron 0 0 1 * *"],
    [trigger({ cronSchedule: "*/15 * * * *", triggerType: "cron" }), "Every 15 minutes"],
    [trigger({ cronSchedule: "*/45 * * * *", triggerType: "cron" }), "Cron */45 * * * *"],
    [
      trigger({
        chainOnStatus: "succeeded",
        chainSourceAutomationNames: ["nightly-fetch"],
        triggerType: "chain",
      }),
      "After nightly-fetch succeeds",
    ],
    [
      trigger({
        chainOnStatus: "all-succeeded",
        chainSourceAutomationNames: ["a", "b", "c"],
        triggerType: "chain",
      }),
      "After 3 automations all succeed",
    ],
    [
      trigger({ chainHiddenSourceCount: 1, triggerType: "chain" }),
      "After an automation you cannot see succeeds",
    ],
  ])("words %#", (input, words) => {
    expect(triggerInWords(input)).toBe(words);
  });

  it("says when a timed automation runs next, and that a webhook runs on call", () => {
    const cron = trigger({
      triggerType: "cron",
      cronIntervalMs: 30_000,
      nextRun: { kind: "at", at: "2026-10-23T12:00:18.000Z" },
    });
    expect(nextRunInWords(cron, NOW)).toBe("in 18 s");
    expect(nextRunInWords(trigger({}), NOW)).toBe("on call");
    expect(nextRunInWords(trigger({ status: "paused" }), NOW)).toBe("Paused");
    expect(nextRunInWords(trigger({ status: "invalid", triggerType: "chain" }), NOW)).toBe("–");
  });

  // The scheduler never advances a cron trigger of an environment it does not serve, so its next
  // run time has passed and never comes.
  it("names the environment no scheduler serves instead of a next run", () => {
    const unserved = trigger({
      environment: "production",
      nextRun: { kind: "unserved", environment: "production" },
      triggerType: "cron",
    });
    expect(nextRunInWords(unserved, NOW)).toBe("No scheduler for production");
    expect(nextRunInWords({ ...unserved, triggerType: "webhook" }, NOW)).toBe("on call");
  });
});
