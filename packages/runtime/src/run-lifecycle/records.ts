import type {
  ControlPlaneStore,
  ErrorClassification,
  ExecutionLease,
  StoredRunExecution,
} from "@swizzle/db";
import { CodedError } from "@swizzle/db";
import { AutomationRuntimeError, getErrorMessage } from "../errors.js";
import type { PlatformRunRecord } from "../platform-types.js";
import type { AutomationRunFailure } from "../run-result.js";

/** A step of the running execution started or finished; the server publishes it for the dashboard. */
export interface RunStepEvent {
  readonly attempt: number;
  readonly executionNumber: number;
  readonly key: string;
  readonly status: "started" | "done";
  readonly timestamp: string;
}

export interface ProcessRunOutcome {
  readonly classification?: ErrorClassification;
  readonly run: PlatformRunRecord;
  readonly shouldRetry: boolean;
}

export async function getRunOrThrow(
  store: ControlPlaneStore,
  runId: string,
): Promise<PlatformRunRecord> {
  const run = await store.getRun(runId);
  if (run === null) {
    throw new AutomationRuntimeError("RUN_NOT_FOUND", `Run not found: ${runId}`, {
      details: { runId },
    });
  }

  return run;
}

/** A lease on a run execution, as the execution service holds it. */
export type RunLease = ExecutionLease & { readonly runId: string };

/**
 * An attempt that failed on the platform's side: the error as its failure, with the output the
 * attempt streamed before it ended.
 */
export function createPlatformRunFailure(
  error: unknown,
  run: PlatformRunRecord,
  lease: Pick<ExecutionLease, "executionNumber">,
): AutomationRunFailure {
  const runtimeError =
    error instanceof AutomationRuntimeError || error instanceof CodedError
      ? error
      : new AutomationRuntimeError("UNEXPECTED_RUNTIME_ERROR", getErrorMessage(error), {
          cause: error instanceof Error ? error : undefined,
        });
  const execution = run.executions.find((entry) => entry.executionNumber === lease.executionNumber);
  return {
    cause: serializeErrorCause(runtimeError.cause ?? error),
    code: runtimeError.code,
    durationMs:
      execution === undefined
        ? 0
        : Math.max(0, Date.now() - new Date(execution.startedAt).getTime()),
    exitCode: null,
    message: runtimeError.message,
    payload: run.payload,
    runId: run.runId,
    signal: null,
    stack: runtimeError.stack ?? (error instanceof Error ? error.stack : null) ?? null,
    stderr: execution?.stderr ?? "",
    stdout: execution?.stdout ?? "",
    success: false,
  };
}

/** The execution a run lease runs: its claim created the row with the lease. */
export function executionOf<T extends Pick<StoredRunExecution, "executionNumber">>(
  run: { readonly executions: readonly T[]; readonly runId: string },
  lease: Pick<ExecutionLease, "executionNumber">,
): T {
  const execution = run.executions.find((entry) => entry.executionNumber === lease.executionNumber);
  if (execution === undefined)
    throw new Error(`Run ${run.runId} has no execution ${lease.executionNumber}.`);
  return execution;
}

export function serializeErrorCause(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
