// An automation's health in words: what its dot shows, the tone of each state, and why a deployment
// cannot run. The pages say every state in words; these pure functions turn API records into them.

import type { AutomationSummary, RunStatus, RuntimeReadiness } from "../api";

/** What an automation's dot shows: why it cannot run, or its latest run's result. */
export type AutomationHealth =
  | "blocked"
  | "failing"
  | "idle"
  | "ok"
  | "paused"
  | "running"
  | "waiting";

export function automationHealth(automation: AutomationSummary): AutomationHealth {
  if (
    automation.trigger?.status === "invalid" ||
    automation.activeDeployment.readiness.status === "not-ready"
  ) {
    return "blocked";
  }
  if (automation.trigger?.status === "paused") return "paused";
  const latest = automation.recentRuns[0];
  if (latest === undefined) return "idle";
  return RUN_HEALTH[latest.status];
}

const RUN_HEALTH: Record<RunStatus, AutomationHealth> = {
  "dead-lettered": "failing",
  failed: "failing",
  queued: "running",
  running: "running",
  succeeded: "ok",
  waiting: "waiting",
};

/** The colour family of a health or run state, as the dot, chip and strip classes name it. */
export type Tone = "fail" | "idle" | "ok" | "run" | "warn";

export const HEALTH_TONE: Record<AutomationHealth, Tone> = {
  blocked: "warn",
  failing: "fail",
  idle: "idle",
  ok: "ok",
  paused: "idle",
  running: "run",
  waiting: "warn",
};

export const RUN_TONE: Record<RunStatus, Tone> = {
  "dead-lettered": "fail",
  failed: "fail",
  queued: "run",
  running: "run",
  succeeded: "ok",
  waiting: "warn",
};

/** Why a deployment cannot run: missing credentials, a broken trigger, or worker requirements. */
export function readinessInWords(readiness: RuntimeReadiness): string {
  const subjects = (code: RuntimeReadiness["errors"][number]["code"]) =>
    readiness.errors.filter((issue) => issue.code === code).map((issue) => issue.subject ?? "");
  const needs = [
    named("secret", subjects("SECRET_MISSING")),
    named("account", subjects("CONNECTION_NOT_ACTIVE")),
  ].filter((phrase) => phrase !== null);
  if (needs.length > 0) return `Needs ${needs.join(" and ")}`;
  return readiness.errors.some((issue) => issue.code === "TRIGGER_CONFIGURATION_INVALID")
    ? "Trigger does not work"
    : "No worker can run it";
}

/** The overview row's short form of `readinessInWords`, which names no secret or account. */
export function readinessLabel(readiness: RuntimeReadiness): string {
  const codes = new Set(readiness.errors.map((issue) => issue.code));
  if (codes.has("SECRET_MISSING")) return "Needs secret";
  if (codes.has("CONNECTION_NOT_ACTIVE")) return "Needs account";
  if (codes.has("TRIGGER_CONFIGURATION_INVALID")) return "Trigger invalid";
  return "Can't run";
}

function named(noun: string, names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `${noun}${names.length === 1 ? "" : "s"} ${names.join(", ")}`;
}
