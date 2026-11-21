import { formatIntervalMs } from "@swizzle/config/browser";
import type { TriggerSummary } from "../api";
import { clockTime, durationInWords } from "./time";

export function triggerInWords(trigger: TriggerSummary | null): string {
  if (trigger === null) return "No trigger";
  switch (trigger.triggerType) {
    case "webhook":
      return trigger.webhookPath === null ? "Webhook" : `Webhook \`${trigger.webhookPath}\``;
    case "cron":
      if (trigger.cronIntervalMs !== null) return intervalInWords(trigger.cronIntervalMs);
      return trigger.cronSchedule === null ? "Timed" : cronInWords(trigger.cronSchedule);
    case "chain":
      return chainInWords(trigger);
  }
}

const UNIT_WORDS: Record<string, string> = { d: "day", h: "hour", m: "minute", s: "second" };

function intervalInWords(ms: number): string {
  const shorthand = formatIntervalMs(ms);
  const single = /^(\d+)([dhms])$/u.exec(shorthand);
  const unit = single?.[2] === undefined ? undefined : UNIT_WORDS[single[2]];
  if (single === null || unit === undefined) return `Every ${shorthand}`;
  const count = Number(single[1]);
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

function cronInWords(schedule: string): string {
  const fields = schedule.trim().split(/\s+/u);
  if (fields.length !== 5) return `Cron ${schedule}`;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  const everyMinutes = /^\*\/(\d+)$/u.exec(minute);
  const step = Number(everyMinutes?.[1]);
  if (
    everyMinutes &&
    60 % step === 0 &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return intervalInWords(step * 60_000);
  }
  const isNumber = (value: string) => /^\d+$/u.test(value);
  if (!isNumber(minute) || dayOfMonth !== "*" || month !== "*") return `Cron ${schedule}`;
  if (hour === "*" && dayOfWeek === "*") return `Hourly at :${minute.padStart(2, "0")}`;
  if (!isNumber(hour)) return `Cron ${schedule}`;
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC`;
  if (dayOfWeek === "*") return `Daily ${time}`;
  if (dayOfWeek === "1-5") return `Weekdays ${time}`;
  const weekday = isNumber(dayOfWeek) ? WEEKDAYS[Number(dayOfWeek) % 7] : undefined;
  return weekday === undefined ? `Cron ${schedule}` : `${weekday} ${time}`;
}

const CHAIN_VERB: Record<string, readonly [single: string, all: string]> = {
  "all-succeeded": ["succeeds", "all succeed"],
  "dead-lettered": ["finally fails", "finally fail"],
  failed: ["fails", "fail"],
  finished: ["finishes", "finish"],
  succeeded: ["succeeds", "succeed"],
};

function chainInWords(trigger: TriggerSummary): string {
  if (trigger.errorCode === "TRIGGER_CHAIN_SOURCE_DELETED") return "Chain source deleted";
  const [single, all] = CHAIN_VERB[trigger.chainOnStatus ?? "succeeded"] ?? ["runs", "run"];
  const sources = chainSourcesInWords(trigger);
  if (sources.length === 1) return `After ${sources[0]} ${single}`;
  return `After ${sources.length} automations ${all}`;
}

export function chainSourcesInWords(trigger: TriggerSummary): readonly string[] {
  return [
    ...trigger.chainSourceAutomationNames,
    ...Array.from({ length: trigger.chainHiddenSourceCount }, () => "an automation you cannot see"),
  ];
}

export function nextRunTimes(
  trigger: TriggerSummary | null,
  now: Date,
): { readonly at: string; readonly relative: string } | null {
  if (trigger?.triggerType !== "cron" || trigger.status !== "active") return null;
  if (trigger.nextRun?.kind !== "at") return null;
  const next = new Date(trigger.nextRun.at);
  const at =
    next.toDateString() === now.toDateString()
      ? clockTime(next)
      : `${next.toLocaleDateString("en-GB", { weekday: "short" })} ${clockTime(next)}`;
  return { at, relative: `in ${durationInWords(Math.max(0, next.getTime() - now.getTime()))}` };
}

export function nextRunInWords(trigger: TriggerSummary | null, now: Date): string {
  if (trigger === null || trigger.status === "invalid") return "–";
  if (trigger.status === "paused") return "Paused";
  if (trigger.triggerType === "webhook") return "on call";
  if (trigger.triggerType === "chain") {
    const sources = chainSourcesInWords(trigger);
    return sources.length === 1 ? `after ${sources[0]}` : "after its sources";
  }
  if (trigger.nextRun?.kind === "unserved")
    return `No scheduler for ${trigger.nextRun.environment}`;
  if (trigger.nextRun === null) return "–";
  const next = new Date(trigger.nextRun.at);
  const inMs = next.getTime() - now.getTime();
  if (inMs < 60 * 60_000) return `in ${durationInWords(Math.max(0, inMs))}`;
  if (inMs < 24 * 60 * 60_000) return clockTime(next);
  return `${next.toLocaleDateString("en-GB", { weekday: "short" })} ${clockTime(next)}`;
}
