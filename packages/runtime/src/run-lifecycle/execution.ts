import type {
  ControlPlaneStore,
  DispatchStore,
  ExecutionSignals,
  WorkerIdentity,
} from "@swizzle/db";
import { isFinishedRun } from "@swizzle/db";
import { recordApiContactLog } from "../api-checks.js";
import { ApiContactLog } from "../api-signals.js";
import { type PreparedExecution, prepareDeployedExecution } from "../deployed-execution.js";
import { type OutputRedactor, redactRunResult } from "../output-redaction.js";
import type { PlatformLogger, PlatformRunRecord } from "../platform-types.js";
import type { AutomationRunResult } from "../run-result.js";
import { createRunLinkEnvironment } from "../wait-links.js";
import { applyRunEvents } from "./events.js";
import { handleFailedRunExecution } from "./failure.js";
import {
  createPlatformRunFailure,
  executionOf,
  getRunOrThrow,
  type ProcessRunOutcome,
  type RunLease,
  type RunStepEvent,
} from "./records.js";
import {
  createSuspendFailure,
  handleSuspendedRunExecution,
  parseSuspendPayload,
} from "./suspension.js";

export async function prepareRunExecution<T>(
  input: {
    readonly dispatch: DispatchStore;
    readonly environment: NodeJS.ProcessEnv;
    readonly identity: WorkerIdentity;
    readonly lease: RunLease;
    readonly store: ControlPlaneStore;
  },
  use: (prepared: PreparedExecution) => Promise<T>,
): Promise<T> {
  const { lease } = input;
  const run = await getRunOrThrow(input.store, lease.runId);
  const injectedAt = new Date().toISOString();
  return await prepareDeployedExecution(
    {
      deployment: run,
      environment: input.environment,
      links: createRunLinkEnvironment({ environment: input.environment, runId: run.runId }),
      recordConnectionUsages: (connections) =>
        input.dispatch.access(input.identity, lease, ({ store }) =>
          store.recordRunExecutionConnectionUsages({
            executionNumber: lease.executionNumber,
            connectionUsages: connections.map((connection) => ({
              connectionName: connection.name,
              environment: connection.environment,
              provider: connection.provider,
              tokenVersion: connection.tokenVersion,
            })),
            injectedAt,
            runId: run.runId,
          }),
        ),
      recordSecretUsages: (secrets) =>
        input.dispatch.access(input.identity, lease, ({ store }) =>
          store.recordRunExecutionSecretUsages({
            executionNumber: lease.executionNumber,
            injectedAt,
            runId: run.runId,
            secretUsages: secrets,
          }),
        ),
      secretNames: run.config.secrets,
      store: input.store,
    },
    async (prepared) => {
      const stateSnapshot = Object.fromEntries(
        (
          await input.store.listAutomationState({
            automationId: run.automationId,
            environment: run.environment,
          })
        ).map((entry) => [entry.key, entry.value]),
      );
      const stepsSnapshot = Object.fromEntries(
        (await input.store.listRunSteps({ runId: run.runId }))
          .filter((entry) => entry.finishedAt !== null)
          .map((entry) => [entry.stepKey, entry.value]),
      );
      return await use({
        redacted: prepared.redacted,
        connectionUsages: [],
        secretUsages: [],
        options: {
          ...prepared.options,
          attempt: executionOf(run, lease).attempt,
          executionNumber: lease.executionNumber,
          inlineJson: JSON.stringify(run.payload),
          runId: run.runId,
          runtimeMetadata: {
            ...prepared.options.runtimeMetadata,
            ...(run.parentRunId !== null ? { parentRunId: run.parentRunId } : {}),
          },
          stateSnapshot,
          stepsSnapshot,
          triggerType: run.triggerType,
          webhookContext: run.webhookContext,
        },
      });
    },
  );
}

export async function finishRunExecution(input: {
  readonly execution: AutomationRunResult | { readonly error: unknown };
  readonly lease: RunLease;
  readonly line: string;
  readonly signals: ExecutionSignals;
  readonly logger?: PlatformLogger;
  readonly onStep?: (event: RunStepEvent) => void;
  readonly redactor: OutputRedactor;
  readonly store: ControlPlaneStore;
}): Promise<ProcessRunOutcome> {
  const { lease, store } = input;
  const currentRun = await getRunOrThrow(store, lease.runId);
  const finishedAt = new Date().toISOString();
  const failure = (error: unknown) => createPlatformRunFailure(error, currentRun, lease);
  let execution = "error" in input.execution ? failure(input.execution.error) : input.execution;
  if (!("error" in input.execution) && input.line.trim().length > 0) {
    const { failed } = await applyRunEvents({
      chunk: "\n",
      lease,
      line: input.line,
      ...(input.onStep !== undefined ? { onStep: input.onStep } : {}),
      run: currentRun,
      store,
    });
    if (failed !== null) execution = failure(failed.error);
  }
  const suspend = parseSuspendPayload(execution.success ? execution.result : null);
  execution = redactRunResult(execution, input.redactor);
  await recordApiContactLog({
    automation: currentRun,
    environment: currentRun.environment,
    log: new ApiContactLog(input.signals.contacts),
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
    redactor: input.redactor,
    store,
  });
  const outcome = await recordRunOutcome({
    execution,
    finishedAt,
    lease,
    rateLimitUsage: new Map(Object.entries(input.signals.rateLimitUsage)),
    run: currentRun,
    store,
    suspend,
  });
  if (isFinishedRun(outcome.run.status)) await store.markRunTerminalPending(outcome.run.runId);
  return outcome;
}

async function recordRunOutcome(input: {
  readonly execution: AutomationRunResult;
  readonly finishedAt: string;
  readonly lease: RunLease;
  readonly rateLimitUsage: ReadonlyMap<string, number>;
  readonly run: PlatformRunRecord;
  readonly store: ControlPlaneStore;
  readonly suspend: ReturnType<typeof parseSuspendPayload>;
}): Promise<ProcessRunOutcome> {
  const { execution, finishedAt, lease, store } = input;
  const latestRun = await getRunOrThrow(store, lease.runId);
  if (isFinishedRun(latestRun.status)) return { run: latestRun, shouldRetry: false };
  const context = {
    executionNumber: lease.executionNumber,
    finishedAt,
    rateLimitUsage: input.rateLimitUsage,
    run: input.run,
    store,
  };
  if (!execution.success) return await handleFailedRunExecution({ ...context, execution });
  if (input.suspend.invalid)
    return await handleFailedRunExecution({
      ...context,
      execution: createSuspendFailure({
        code: "SUSPEND_PAYLOAD_INVALID",
        execution,
        message: input.suspend.message,
        run: input.run,
      }),
    });
  if (input.suspend.payload !== null)
    return await handleSuspendedRunExecution({
      ...context,
      execution,
      payload: input.suspend.payload,
    });

  await store.completeRunExecution({
    executionNumber: lease.executionNumber,
    durationMs: execution.durationMs,
    finishedAt,
    metadata: {
      exitCode: execution.exitCode,
      ...(execution.phases !== undefined ? { phases: execution.phases } : {}),
      rateLimitUsage: Object.fromEntries(input.rateLimitUsage),
    },
    runId: lease.runId,
    status: "succeeded",
    stderr: execution.stderr,
    stdout: execution.stdout,
  });
  await store.updateRunState({
    deadLetterReason: null,
    errorClassification: null,
    errorCode: null,
    errorMessage: null,
    finishedAt,
    result: execution.result,
    runId: lease.runId,
    status: "succeeded",
    stderr: execution.stderr,
    stdout: execution.stdout,
  });
  return { run: await getRunOrThrow(store, lease.runId), shouldRetry: false };
}
