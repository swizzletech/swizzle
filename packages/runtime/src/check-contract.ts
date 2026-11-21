import type {
  ApiCheckReport,
  AutomationCheckStatus,
  CompleteAutomationCheckInput,
  StoredAutomationCheck,
} from "@swizzle/db";

import { findContractChange, readStructuredEvents } from "./api-signals.js";
import { exceptionSummary, findRunException } from "./run-exception.js";

import type { AutomationRunFailure, AutomationRunSuccess } from "./run-result.js";

const MAX_OUTPUT_CHARS = 8_192;
const MAX_MESSAGE_CHARS = 4_096;

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

export function checkOutcome(
  execution:
    | Pick<AutomationRunSuccess, "result" | "stdout" | "stderr" | "success">
    | Pick<AutomationRunFailure, "code" | "exitCode" | "message" | "stdout" | "stderr" | "success">,
): CheckOutcome {
  const output = boundedOutput(execution.stdout);
  const result = execution.success ? execution.result : parseOutput(execution.stdout);
  const report = { ...checkReport(result), change: findContractChange(execution.stderr) };
  if (execution.success && report.ok) return { output: output ?? "", report, status: "green" };
  let lastContactStatus: number | null = null;
  readStructuredEvents("", `${execution.stderr}\n`, (event) => {
    if (
      event.type === "api_contact" &&
      typeof event.status === "number" &&
      Number.isInteger(event.status) &&
      event.status >= 100 &&
      event.status <= 599
    ) {
      lastContactStatus = event.status;
    }
  });
  let credentials: string | undefined;
  if (lastContactStatus === 401 || lastContactStatus === 403) {
    credentials = `HTTP ${lastContactStatus}`;
  } else if (lastContactStatus === null) {
    credentials = execution.stderr.split(/\r?\n/u).findLast((line) => {
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
  }
  if (execution.success)
    return {
      exitCode: 0,
      failure: credentials === undefined ? "execution" : "credentials",
      message:
        credentials === undefined
          ? 'The check exited 0 without "ok": true on stdout.'
          : `API check credentials failed: ${credentials.trim()}`.slice(0, MAX_MESSAGE_CHARS),
      output,
      report,
      status: "error",
    };
  if (credentials === undefined && report.change !== null)
    return { output, report, status: "drift" };
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
    status:
      outcome.status === "error" && outcome.failure === "credentials"
        ? "credentials"
        : outcome.status,
  };
}

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
