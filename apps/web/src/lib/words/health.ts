import type { AutomationSummary, RunState, RuntimeReadiness } from "../api";

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
  return RUN_HEALTH[latest.state];
}

const RUN_HEALTH: Record<RunState, AutomationHealth> = {
  cancelled: "idle",
  "dead-lettered": "failing",
  failed: "failing",
  queued: "running",
  running: "running",
  succeeded: "ok",
  waiting: "waiting",
};

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

export const RUN_TONE: Record<RunState, Tone> = {
  cancelled: "idle",
  "dead-lettered": "fail",
  failed: "fail",
  queued: "run",
  running: "run",
  succeeded: "ok",
  waiting: "warn",
};

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
