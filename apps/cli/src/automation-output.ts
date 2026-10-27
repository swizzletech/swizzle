import type { AutomationApiCheck } from "@swizzle/config";
import type { RuntimeReadinessReport } from "@swizzle/runtime";

import type { CliIO } from "./output.js";

/** `active (check.ts, every 7d)`, `passive (untested after 30d)` or `off: <reason>`. */
export function formatApiCheckSummary(apiCheck: AutomationApiCheck | undefined): string {
  switch (apiCheck?.mode) {
    case undefined:
      return "none (no secrets or connections reach an outside API)";
    case "active": {
      const secrets =
        apiCheck.secrets === undefined ? "" : `, secrets: ${formatList(apiCheck.secrets)}`;
      return `active (${apiCheck.entrypoint}, every ${apiCheck.every}${secrets})`;
    }
    case "passive":
      return `passive (untested after ${apiCheck.untested_after})`;
    case "off":
      return `off: ${apiCheck.reason}`;
  }
}

export function formatTriggerSummary(trigger: {
  readonly every?: string | undefined;
  readonly on?: string | undefined;
  readonly path?: string | undefined;
  readonly payload?: string | undefined;
  readonly schedule?: string | undefined;
  readonly source?: string | undefined;
  readonly sources?: readonly string[] | undefined;
  readonly type: string;
}): string {
  if (trigger.type === "webhook") {
    return trigger.path ? `webhook (${trigger.path})` : "webhook";
  }
  if (trigger.type === "chain") {
    const source = trigger.sources?.join(", ") ?? trigger.source ?? "?";
    const on = trigger.on ?? "succeeded";
    const payload =
      trigger.payload && trigger.payload !== "result" ? `, payload ${trigger.payload}` : "";
    return `chain (source: ${source}, on: ${on}${payload})`;
  }
  if (trigger.every) return `cron (every ${trigger.every})`;
  return trigger.schedule ? `cron (${trigger.schedule})` : trigger.type;
}

export function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

export function writeStderrLogs(io: CliIO, stderr: string): void {
  if (stderr.length === 0) return;
  io.stderr(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
}

/** A readiness report as validate and apply --dry-run print it, with whose workers judged it. */
export function readinessFields(readiness: RuntimeReadinessReport, judgedBy: string) {
  return {
    readiness: `${readiness.status} (${judgedBy})`,
    ...(readiness.errors.length > 0
      ? { readinessErrors: readiness.errors.map((issue) => issue.message) }
      : {}),
    ...(readiness.warnings.length > 0
      ? { readinessWarnings: readiness.warnings.map((issue) => issue.message) }
      : {}),
  };
}
