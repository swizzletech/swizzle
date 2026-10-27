/**
 * How a run reads on stdout: `runView` is the detail `runs inspect` prints, with its result parsed
 * and its logs as a preview; `windowLog` cuts the full logs `swizzle logs` prints. Both say how
 * much they left out, so the reader knows what `--full` adds.
 */
import type { ExecutionWait, RunWait } from "@swizzle/db";
import { placementInWords } from "@swizzle/runtime";

import type { RunDetailRecord as ApiRun } from "./run-records.js";

type RunDetailRecord = Pick<
  ApiRun,
  | "runId"
  | "automationSlug"
  | "automationName"
  | "environment"
  | "status"
  | "triggerType"
  | "attemptsMade"
  | "attemptsMax"
  | "queuedAt"
  | "startedAt"
  | "finishedAt"
  | "errorCode"
  | "errorMessage"
  | "deadLetterReason"
  | "wait"
  | "placement"
  | "stdout"
  | "stderr"
> & {
  readonly executions: readonly Pick<
    ApiRun["executions"][number],
    | "attempt"
    | "executionNumber"
    | "resumedAfter"
    | "status"
    | "stderr"
    | "stdout"
    | "durationMs"
    | "errorMessage"
    | "metadata"
    | "workerName"
  >[];
};

/** What `swizzle logs` prints of each stream unless `--full`, `--head` or `--tail` widen it. */
const DEFAULT_LOG_MAX_BYTES = 8 * 1024;
/** What `runs inspect` previews of stdout and stderr. */
const PREVIEW_MAX_BYTES = 1024;

export interface LogWindowOptions {
  readonly full?: boolean;
  readonly head?: number;
  readonly tail?: number;
}

export interface WindowedLog {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
}

/**
 * The part of a log the caller asked for: everything, the first or last lines, or by default the
 * first and last bytes around a marker that counts what was cut.
 */
export function windowLog(
  text: string,
  options: LogWindowOptions,
  maxBytes = DEFAULT_LOG_MAX_BYTES,
): WindowedLog {
  const totalBytes = Buffer.byteLength(text, "utf8");
  // A final newline ends the last line; it does not start another.
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (options.full === true) return { text, totalBytes, truncated: false };
  if (options.head !== undefined) {
    return {
      text: lines.slice(0, options.head).join("\n"),
      totalBytes,
      truncated: lines.length > options.head,
    };
  }
  if (options.tail !== undefined) {
    return {
      text: lines.slice(-options.tail).join("\n"),
      totalBytes,
      truncated: lines.length > options.tail,
    };
  }
  if (totalBytes <= maxBytes) return { text, totalBytes, truncated: false };
  const buffer = Buffer.from(text, "utf8");
  const tailBytes = Math.min(Math.floor(maxBytes / 2), 4096);
  const headBytes = maxBytes - tailBytes;
  const omitted = totalBytes - headBytes - tailBytes;
  return {
    text: `${buffer.subarray(0, headBytes).toString("utf8")}\n... (truncated ${omitted} of ${totalBytes} bytes) ...\n${buffer.subarray(totalBytes - tailBytes).toString("utf8")}`,
    totalBytes,
    truncated: true,
  };
}

/** The last bytes of a log, where a failure explains itself. */
function tailPreview(text: string): string {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= PREVIEW_MAX_BYTES) return text;
  const buffer = Buffer.from(text, "utf8");
  return `... (last ${PREVIEW_MAX_BYTES} of ${totalBytes} bytes)\n${buffer.subarray(totalBytes - PREVIEW_MAX_BYTES).toString("utf8")}`;
}

/** What a waiting run waits for, in one line. */
export function waitText(wait: RunWait | null | undefined): string | null {
  if (wait == null) return null;
  switch (wait.reason) {
    case "sleep":
      return `sleep until ${wait.until}`;
    case "child":
      return `child automation (step ${wait.stepKey})`;
    case "claim":
      return `claim ${wait.stepKey}`;
    case "event":
      return `event ${wait.stepKey}${wait.until ? ` until ${wait.until}` : ""}`;
    case "approval":
      return `approval ${wait.stepKey}${wait.assignee ? ` by ${wait.assignee.label}` : ""}${wait.until ? ` until ${wait.until}` : ""}`;
  }
}

/** The wait an execution resumed the run after, as "approval gate-1"; null for none. */
function waitLabel(wait: ExecutionWait | null): string | null {
  return wait === null ? null : `${wait.reason} ${wait.stepKey}`;
}

/**
 * The run's log across its executions. `run.stderr` holds only the last one's, so a run that
 * resumed from a wait or retried would lose its earlier lines; each execution that logged gets a
 * header line naming it and the attempt it spent.
 */
export function runStderr(run: RunDetailRecord): string {
  const all = run.executions;
  const logged = all.filter((execution) => (execution.stderr ?? "") !== "");
  if (all.length < 2 || logged.length === 0) return run.stderr ?? "";
  return logged
    .map((execution) => {
      const text = execution.stderr ?? "";
      const wait = waitLabel(execution.resumedAfter);
      const resumed = wait === null ? "" : `, resumed after ${wait}`;
      return `--- execution ${execution.executionNumber}, attempt ${execution.attempt}${resumed} (${execution.status})\n${text.endsWith("\n") ? text : `${text}\n`}`;
    })
    .join("");
}

/**
 * One run as `runs inspect` prints it. stdout is the run's result, parsed when it is JSON; stderr
 * is its log, previewed from the end. `full` adds both streams whole and every execution's logs.
 */
export function runView(run: RunDetailRecord, full: boolean) {
  const stdoutText = run.stdout ?? "";
  const stderrText = runStderr(run);
  const result = parseResult(stdoutText);
  const history = run.executions;
  return {
    id: run.runId,
    automation: run.automationSlug ?? run.automationName ?? null,
    ...(run.environment !== undefined ? { environment: run.environment } : {}),
    status: run.status,
    trigger: run.triggerType,
    attempts: `${run.attemptsMade}/${run.attemptsMax}`,
    ...(history.length > 0 ? { worker: history[history.length - 1]?.workerName } : {}),
    queuedAt: run.queuedAt ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    ...(run.errorCode != null
      ? { error: `${run.errorCode}: ${run.errorMessage ?? ""}`.trim() }
      : {}),
    ...(run.deadLetterReason != null ? { deadLetterReason: run.deadLetterReason } : {}),
    ...(run.status === "waiting" && run.wait != null ? { waitingFor: waitText(run.wait) } : {}),
    ...(run.placement !== null
      ? {
          waitingForWorker: `${placementInWords(run.placement, run).reason} Fails at ${run.placement.deadline}.`,
        }
      : {}),
    ...(result.parsed
      ? { result: result.value }
      : stdoutText.length > 0
        ? { stdout: full ? stdoutText : tailPreview(stdoutText) }
        : {}),
    ...(stderrText.length > 0 ? { stderr: full ? stderrText : tailPreview(stderrText) } : {}),
    ...(history.length > 1 || full
      ? {
          attemptHistory: history.map((execution) => ({
            execution: execution.executionNumber,
            attempt: execution.attempt,
            resumedAfter: waitLabel(execution.resumedAfter),
            status: execution.status,
            worker: execution.workerName,
            durationMs: execution.durationMs ?? null,
            error: execution.errorMessage ?? null,
            rateLimitUsage: rateLimitUsage(execution.metadata?.rateLimitUsage),
          })),
        }
      : {}),
  };
}

/** Whether `runs inspect` cut a stream, so it offers `--full` only when there is more. */
export function runViewTruncated(run: RunDetailRecord): boolean {
  const stdoutText = run.stdout ?? "";
  return (
    Buffer.byteLength(runStderr(run), "utf8") > PREVIEW_MAX_BYTES ||
    (!parseResult(stdoutText).parsed && Buffer.byteLength(stdoutText, "utf8") > PREVIEW_MAX_BYTES)
  );
}

function parseResult(stdoutText: string): { readonly parsed: boolean; readonly value?: unknown } {
  if (stdoutText.trim().length === 0) return { parsed: false };
  try {
    return { parsed: true, value: JSON.parse(stdoutText) };
  } catch {
    return { parsed: false };
  }
}

function rateLimitUsage(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  return entries.length === 0 ? null : entries.map(([name, count]) => `${name}=${count}`).join(" ");
}
