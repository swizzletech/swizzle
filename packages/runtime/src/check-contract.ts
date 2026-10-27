// The check contract, free of the queue and database clients so the CLI's `swizzle run --check`
// and the API's Needs you read it from the cheap `@swizzle/runtime` entry: how a check process
// ends (green, drift or undecided), how that folds into its record, and when it needs the owner.
import type {
  ApiCheckReport,
  AutomationCheckStatus,
  CompleteAutomationCheckInput,
  StoredAutomationCheck,
} from "@swizzle/db";

import { findContractChange } from "./api-signals.js";

import type { AutomationRunFailure, AutomationRunSuccess } from "./run-result.js";

const MAX_OUTPUT_CHARS = 8_192;

/** How one check process ended, before it is folded into the record. */
export type CheckOutcome = { readonly report: ApiCheckReport } & (
  | { readonly status: "green"; readonly output: string }
  | { readonly status: "drift"; readonly output: string | null }
  | {
      readonly status: "error";
      readonly exitCode: number | null;
      readonly message: string;
      readonly output: string | null;
    }
);

/**
 * The check contract: exit 0 with `"ok": true` on stdout is green, exit 1 is drift (the check
 * reached the API and the answer differs), anything else could not decide.
 */
export function checkOutcome(
  execution:
    | Pick<AutomationRunSuccess, "result" | "stdout" | "stderr" | "success">
    | Pick<AutomationRunFailure, "code" | "exitCode" | "message" | "stdout" | "stderr" | "success">,
): CheckOutcome {
  const output = boundedOutput(execution.stdout);
  const result = execution.success ? execution.result : parseOutput(execution.stdout);
  const report = { ...checkReport(result), change: findContractChange(execution.stderr) };
  if (execution.success) {
    if (report.ok) {
      return { output: output ?? "", report, status: "green" };
    }
    return {
      exitCode: 0,
      message: 'The check exited 0 without "ok": true on stdout.',
      output,
      report,
      status: "error",
    };
  }
  if (
    execution.exitCode === 1 &&
    (execution.code === "PROCESS_EXIT_NON_ZERO" || execution.code === "UPSTREAM_CONTRACT_CHANGED")
  ) {
    return { output, report, status: "drift" };
  }
  return {
    exitCode: execution.exitCode,
    message: execution.message,
    output,
    report,
    status: "error",
  };
}

/** Folds an outcome into the record: the failure streak, its start, and the next due time. */
export function nextCheckState(
  previous: Pick<StoredAutomationCheck, "consecutiveFailures" | "everyMs" | "failingSince">,
  outcome: CheckOutcome,
  checkedAt: Date,
): Pick<
  CompleteAutomationCheckInput,
  "checkedAt" | "consecutiveFailures" | "failingSince" | "nextCheckAt" | "output" | "report"
> & { readonly status: Exclude<AutomationCheckStatus, "pending"> } {
  const failing = outcome.status !== "green";
  return {
    checkedAt: checkedAt.toISOString(),
    consecutiveFailures: failing ? previous.consecutiveFailures + 1 : 0,
    failingSince: failing ? (previous.failingSince ?? checkedAt.toISOString()) : null,
    nextCheckAt: new Date(checkedAt.getTime() + previous.everyMs).toISOString(),
    output: outcome.output,
    report: outcome.report,
    status: outcome.status,
  };
}

/** Parse process output once, before it becomes a persisted report. */
function parseOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function checkReport(value: unknown): ApiCheckReport {
  if (value === null || typeof value !== "object") {
    return { change: null, checked: [], ok: false };
  }
  const checked: unknown = Reflect.get(value, "checked");
  return {
    change: null,
    checked: Array.isArray(checked)
      ? checked.filter((call): call is string => typeof call === "string")
      : [],
    ok: Reflect.get(value, "ok") === true,
  };
}

function boundedOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_OUTPUT_CHARS);
}
