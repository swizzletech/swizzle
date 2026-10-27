import type {
  ControlPlaneStore,
  ErrorClassification,
  ExpiredPlacement,
  LostExecution,
} from "@swizzle/db";
import { isFinishedRun, unservedProjectMessage } from "@swizzle/db";
import { AutomationRuntimeError } from "../errors.js";
import type { PlatformRunExecutionStatus, PlatformRunRecord } from "../platform-types.js";
import type { AutomationRunFailure } from "../run-result.js";
import {
  createPlatformRunFailure,
  executionOf,
  getRunOrThrow,
  type ProcessRunOutcome,
} from "./records.js";

/**
 * The one retry and dead-letter decision for a failed execution, whether the process failed or the
 * worker lost its lease: retry while the failure is retryable and the segment has attempts left.
 */
export async function handleFailedRunExecution(input: {
  readonly executionNumber: number;
  readonly execution: AutomationRunFailure;
  readonly finishedAt: string;
  readonly rateLimitUsage?: ReadonlyMap<string, number>;
  readonly run: PlatformRunRecord;
  readonly store: ControlPlaneStore;
}): Promise<ProcessRunOutcome> {
  const classification = classifyFailure(input.execution);
  const { attempt } = executionOf(input.run, input);
  const shouldRetry = classification === "retryable" && attempt < input.run.attemptsMax;
  const executionStatus: PlatformRunExecutionStatus = shouldRetry ? "retrying" : "dead-lettered";

  await input.store.completeRunExecution({
    executionNumber: input.executionNumber,
    durationMs: input.execution.durationMs,
    errorCause: input.execution.cause ?? null,
    errorClassification: classification,
    errorCode: input.execution.code,
    errorMessage: input.execution.message,
    errorStack: input.execution.stack ?? null,
    finishedAt: input.finishedAt,
    metadata: {
      exitCode: input.execution.exitCode,
      ...(input.execution.phases !== undefined ? { phases: input.execution.phases } : {}),
      rateLimitUsage: Object.fromEntries(input.rateLimitUsage ?? []),
      signal: input.execution.signal,
    },
    runId: input.run.runId,
    status: executionStatus,
    stderr: input.execution.stderr,
    stdout: input.execution.stdout,
  });

  if (shouldRetry) {
    await input.store.updateRunState({
      deadLetterReason: null,
      errorCause: input.execution.cause ?? null,
      errorClassification: classification,
      errorCode: input.execution.code,
      errorMessage: input.execution.message,
      errorStack: input.execution.stack ?? null,
      runId: input.run.runId,
      status: "queued",
      stderr: input.execution.stderr,
      stdout: input.execution.stdout,
    });
  } else {
    await input.store.updateRunState({
      deadLetterReason: classification === "terminal" ? "terminal-failure" : "retries-exhausted",
      errorCause: input.execution.cause ?? null,
      errorClassification: classification,
      errorCode: input.execution.code,
      errorMessage: input.execution.message,
      errorStack: input.execution.stack ?? null,
      finishedAt: input.finishedAt,
      runId: input.run.runId,
      status: "dead-lettered",
      stderr: input.execution.stderr,
      stdout: input.execution.stdout,
    });
  }

  const updatedRun = await getRunOrThrow(input.store, input.run.runId);
  return {
    classification,
    run: updatedRun,
    shouldRetry,
  };
}

const LOST_BEFORE_START = "WORKER_LOST_BEFORE_START";

/**
 * Ends the execution of a lease its worker lost, in the transaction that releases the lease. A
 * delivery lost before `start` released no secrets, so no process ran and it spends no attempt.
 * Only one such delivery per attempt is free, so a worker that always fails before start still
 * exhausts the retry policy. Any other loss is a WORKER_LEASE_LOST failure under that policy.
 */
export async function loseRunExecution(
  input: LostExecution & { readonly store: ControlPlaneStore },
): Promise<void> {
  const { lease, store } = input;
  const run = await getRunOrThrow(store, lease.runId);
  const finishedAt = new Date().toISOString();
  const previous = run.executions.find(
    (entry) => entry.executionNumber === lease.executionNumber - 1,
  );
  if (!input.started && previous?.errorCode !== LOST_BEFORE_START) {
    const execution = executionOf(run, lease);
    const lost = {
      errorClassification: "retryable",
      errorCode: LOST_BEFORE_START,
      errorMessage: "Worker lost the assignment before it started; no attempt was spent.",
    } as const;
    await store.completeRunExecution({
      ...lost,
      executionNumber: lease.executionNumber,
      durationMs: 0,
      finishedAt,
      runId: run.runId,
      status: "retrying",
      stderr: execution.stderr,
      stdout: execution.stdout,
    });
    await store.updateRunState({
      ...lost,
      attemptsMade: execution.attempt - 1,
      runId: run.runId,
      status: "queued",
    });
    return;
  }
  const outcome = await handleFailedRunExecution({
    executionNumber: lease.executionNumber,
    execution: createPlatformRunFailure(
      new AutomationRuntimeError(
        "WORKER_LEASE_LOST",
        "Worker execution lease expired or was revoked.",
      ),
      run,
      lease,
    ),
    finishedAt,
    run,
    store,
  });
  if (isFinishedRun(outcome.run.status)) await store.markRunTerminalPending(run.runId);
}

/**
 * Dead-letters a queued run no worker took within its queue timeout; it spends no attempt. Its
 * terminal effects are those of any dead letter: notifications, and a waiting parent resumes.
 */
export async function failPlacement(
  input: ExpiredPlacement & { readonly store: ControlPlaneStore },
): Promise<void> {
  const { run, store } = input;
  await store.markRunTerminalPending(run.runId);
  await store.updateRunState({
    runId: run.runId,
    status: "dead-lettered",
    finishedAt: new Date().toISOString(),
    errorCode: "PLACEMENT_TIMEOUT",
    errorClassification: "terminal",
    errorMessage: unservedProjectMessage({
      project: { id: run.projectId, name: input.projectName },
      environment: run.environment,
      profile: run.config.runtime.profile,
      within: run.config.runtime.queue_timeout,
    }),
    deadLetterReason: "placement-timeout",
  });
}

/**
 * Retryable: the process failed in a way another attempt can pass, Docker failed the platform, or
 * the worker lost the execution's lease.
 */
function classifyFailure(result: AutomationRunFailure): ErrorClassification {
  switch (result.code) {
    case "CONTAINER_RUNTIME_UNAVAILABLE":
    case "DOCKER_CONTROL_TIMEOUT":
    case "DOCKER_TRANSFER_TIMEOUT":
    case "PROCESS_EXIT_NON_ZERO":
    case "PROCESS_SIGNAL":
    case "PROCESS_TIMEOUT":
    case "UNEXPECTED_RUNTIME_ERROR":
    case "WORKER_LEASE_LOST":
      return "retryable";
    default:
      return "terminal";
  }
}
