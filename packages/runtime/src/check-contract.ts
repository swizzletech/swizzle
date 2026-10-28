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
import { exceptionSummary, findRunException } from "./run-exception.js";

import type { AutomationRunFailure, AutomationRunSuccess } from "./run-result.js";

const MAX_OUTPUT_CHARS = 8_192;
const MAX_MESSAGE_CHARS = 4_096;

/** How one check process ended, before it is folded into the record. */
export type CheckOutcome = { readonly report: ApiCheckReport } & (
  | { readonly status: "green"; readonly output: string }
  | { readonly status: "drift"; readonly output: string | null }
  | {
      readonly status: "error";
      readonly failure: "credentials" | "execution";
      readonly exitCode: number | null;
      readonly message: string;
      readonly output: string | null;
    }
);

/**
 * Exit 0 with `"ok": true` on stdout is green. A contract_changed event or bare exit 1 is drift.
 * Recognizable exceptions and credential failures are errors, including exit 1. Anything else
 * could not decide.
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
      failure: "execution",
      message: 'The check exited 0 without "ok": true on stdout.',
      output,
      report,
      status: "error",
    };
  }
  if (report.change !== null) return { output, report, status: "drift" };
  const credentials = execution.stderr.split(/\r?\n/u).findLast((line) => {
    if (
      /AUTHENTICATIONFAILED|authentication failed|invalid credentials|invalid password|login failed|\b(?:401 Unauthorized|403 Forbidden)\b/iu.test(
        line,
      )
    )
      return true;
    return /(?:^|[ \t])(?:(?:HTTP)+(?:Error)?(?:\/[0-9]+(?:\.[0-9]+)?)?|status(?:[ \t]+code)?|response)[ \t:]+(?:401|403)\b/iu.test(
      line,
    );
  });
  const exception = findRunException(execution.stderr);
  if (
    credentials !== undefined ||
    exception !== null ||
    execution.stderr.includes("Traceback (most recent call last):") ||
    /^[ \t]+at .+:\d+:\d+\)?$/mu.test(execution.stderr)
  ) {
    let message = execution.message;
    if (credentials !== undefined) {
      message = `API check credentials failed: ${credentials.trim()}`;
    } else if (exception !== null) {
      message = exceptionSummary(exception);
    }
    return {
      exitCode: execution.exitCode,
      failure: credentials === undefined ? "execution" : "credentials",
      message: message.slice(0, MAX_MESSAGE_CHARS),
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
    failure: "execution",
    message: execution.message.slice(0, MAX_MESSAGE_CHARS),
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
