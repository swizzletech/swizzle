import { createHash } from "node:crypto";
import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "@swizzle/core";
import type {
  ControlPlaneStore,
  DispatchStore,
  ExecutionLease,
  ExecutionState,
  LeaseRef,
  LeaseScope,
  WorkerIdentity,
} from "@swizzle/db";
import { ExecutionLeaseError, isFinishedRun } from "@swizzle/db";
import { dueCheck, finishCheckExecution, prepareCheckExecution } from "./api-checks.js";
import { NO_SIGNALS, readExecutionSignals } from "./api-signals.js";
import { type PreparedExecution, readDeployedSource } from "./deployed-execution.js";
import { AutomationRuntimeError } from "./errors.js";
import {
  acceptExecutionReport,
  createExecutionDelivery,
  type ExecutionDelivery,
} from "./execution-wire.js";
import type { RunLogEvent } from "./log-stream.js";
import { createRunOutputRedactor } from "./output-redaction.js";
import type { PlatformLogger } from "./platform-types.js";
import {
  applyRunEvents,
  finishRunExecution,
  getRunOrThrow,
  prepareRunExecution,
  type RunStepEvent,
} from "./run-lifecycle.js";
import type {
  ExecutionAssignment,
  ExecutionReport,
  ExecutionSecrets,
  ExecutionSource,
} from "./worker-wire.js";

const MAX_OUTPUT_BYTES = 1_048_576;
const FRESH: ExecutionState = {
  secrets: {},
  redacted: [],
  sequence: 0,
  digest: null,
  stdout: { bytes: 0, pending: "" },
  stderr: { bytes: 0, pending: "" },
  line: "",
  signals: NO_SIGNALS,
  connectionUsages: [],
  secretUsages: [],
};
const PREPARATION_RENEWAL_MS = 1_000;

interface Ended {
  readonly lease: ExecutionLease;
  readonly outcome: Awaited<ReturnType<typeof finishRunExecution>> | null;
  readonly steps: readonly RunStepEvent[];
}

export interface ExecutionService {
  prepare(
    identity: WorkerIdentity,
    lease: ExecutionLease,
    signal?: AbortSignal,
  ): Promise<ExecutionAssignment | null>;
  source(identity: WorkerIdentity, lease: LeaseRef): Promise<ExecutionSource>;
  start(identity: WorkerIdentity, lease: LeaseRef): Promise<ExecutionSecrets>;
  ready(identity: WorkerIdentity, lease: LeaseRef): Promise<void>;
  output(
    identity: WorkerIdentity,
    lease: LeaseRef,
    sequence: number,
    stream: "stdout" | "stderr",
    chunk: string,
  ): Promise<void>;
  complete(identity: WorkerIdentity, lease: LeaseRef, report: ExecutionReport): Promise<void>;
}

export function createExecutionService(options: {
  readonly dispatch: DispatchStore;
  readonly environment: NodeJS.ProcessEnv;
  readonly logger?: PlatformLogger;
  readonly publish?: (event: RunLogEvent) => Promise<void>;
  readonly store: ControlPlaneStore;
}): ExecutionService {
  const { dispatch, environment, store } = options;
  const publish = (event: RunLogEvent) => {
    void options
      .publish?.(event)
      .catch((error) => options.logger?.warn({ error }, "Log publication failed."));
  };
  const publishStep = (step: RunStepEvent, runId: string) =>
    publish({
      type: "step",
      runId,
      attempt: step.attempt,
      executionNumber: step.executionNumber,
      key: step.key,
      status: step.status,
      timestamp: step.timestamp,
    });

  const end = async (
    scope: LeaseScope,
    digest: string | null,
    ended: ExecutionReport | { readonly error: unknown },
    state: ExecutionState | null = scope.executionState,
  ): Promise<Ended> => {
    const { lease } = scope;
    return await getTracer("@swizzle/runtime").startActiveSpan(
      "automation.complete",
      {
        attributes: {
          "automation.run_id": lease.runId ?? "",
          "automation.execution": lease.executionNumber,
          "worker.id": lease.workerId,
        },
      },
      async (span) => {
        try {
          if (state === null) throw new ExecutionLeaseError();
          const { store } = scope;
          const redactor = createRunOutputRedactor(state.redacted);
          const { signals } =
            "error" in ended
              ? state
              : readExecutionSignals(state.signals, state.line, "\n", new Date().toISOString());
          const steps: RunStepEvent[] = [];
          let outcome: Ended["outcome"] = null;
          if (lease.runId === null) {
            await finishCheckExecution({
              execution:
                "error" in ended
                  ? ended
                  : acceptExecutionReport(ended, {
                      payload: null,
                      runId: `check-${lease.checkId}`,
                    }),
              lease,
              ...(options.logger !== undefined ? { logger: options.logger } : {}),
              redactor,
              connectionUsages: state.connectionUsages,
              secretUsages: state.secretUsages,
              signals,
              store,
            });
          } else {
            const run = await getRunOrThrow(store, lease.runId);
            outcome = await finishRunExecution({
              execution: "error" in ended ? ended : acceptExecutionReport(ended, run),
              lease,
              line: state.line,
              ...(options.logger !== undefined ? { logger: options.logger } : {}),
              onStep: (step) => steps.push(step),
              redactor,
              signals,
              store,
            });
            span.setAttribute("automation.status", outcome.run.status);
            if (outcome.classification !== undefined)
              span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.classification });
          }
          await scope.release(digest);
          return { lease, outcome, steps };
        } finally {
          span.end();
        }
      },
    );
  };
  const announce = ({ lease, outcome, steps }: Ended) => {
    if (outcome === null || lease.runId === null) return;
    for (const step of steps) publishStep(step, lease.runId);
    publish({
      type: "status",
      runId: lease.runId,
      executionNumber: lease.executionNumber,
      status: outcome.run.status,
      terminal: isFinishedRun(outcome.run.status),
      timestamp: new Date().toISOString(),
    });
  };
  const finish = async (
    identity: WorkerIdentity,
    lease: LeaseRef,
    digest: string | null,
    ended: ExecutionReport | { readonly error: unknown },
    state?: ExecutionState,
  ) =>
    announce(await dispatch.access(identity, lease, (scope) => end(scope, digest, ended, state)));

  return {
    async prepare(identity, lease, signal) {
      let current = lease;
      let lost = false;
      let renewing = Promise.resolve();
      const renewal = setInterval(() => {
        renewing = renewing.then(async () => {
          if (!lost)
            current = await dispatch.renew(identity, current).catch(() => {
              lost = true;
              return current;
            });
        });
      }, PREPARATION_RENEWAL_MS);
      const stopRenewal = async () => {
        clearInterval(renewal);
        await renewing;
      };
      let preparation: {
        readonly prepared: PreparedExecution;
        readonly delivery: ExecutionDelivery;
      };
      try {
        const use = async (prepared: PreparedExecution) => ({
          prepared,
          delivery: await createExecutionDelivery(
            current,
            lease.runId === null ? "check" : "run",
            prepared.options,
          ),
        });
        preparation =
          lease.runId === null
            ? await prepareCheckExecution({ environment, lease, store }, use)
            : await prepareRunExecution({ dispatch, environment, identity, lease, store }, use);
      } catch (error) {
        await stopRenewal();
        if (error instanceof ExecutionLeaseError || lost) return null;
        await finish(identity, current, null, { error }, FRESH).catch((finishError) => {
          if (!(finishError instanceof ExecutionLeaseError)) throw finishError;
        });
        return null;
      } finally {
        await stopRenewal();
      }
      const { prepared, delivery } = preparation;
      if (lost || signal?.aborted) return null;
      try {
        await dispatch.access(identity, current, (scope) =>
          scope.save({
            ...FRESH,
            secrets: delivery.secrets,
            redacted: prepared.redacted,
            connectionUsages: prepared.connectionUsages,
            secretUsages: prepared.secretUsages,
          }),
        );
        current = await dispatch.renew(identity, current);
      } catch (error) {
        if (error instanceof ExecutionLeaseError) return null;
        throw error;
      }
      return { ...delivery.assignment, lease: current };
    },
    async source(identity, ref) {
      const deployment = await dispatch.access(
        identity,
        ref,
        async ({ executionState: state, lease, store }) => {
          if (state === null) throw new ExecutionLeaseError();
          if (lease.runId !== null) return await getRunOrThrow(store, lease.runId);
          const due = await dueCheck(store, lease);
          if (due === null) throw new ExecutionLeaseError();
          return due.deployment;
        },
      );
      const source = await readDeployedSource(deployment, environment);
      await dispatch.access(identity, ref, async ({ executionState: state }) => {
        if (state === null) throw new ExecutionLeaseError();
      });
      return source;
    },
    async start(identity, ref) {
      return (await dispatch.start(identity, ref)).secrets;
    },
    async ready(identity, ref) {
      await dispatch.access(identity, ref, async ({ lease, store, executionState }) => {
        if (executionState === null) throw new ExecutionLeaseError();
        if (lease.runId !== null)
          await store.markRunExecutionReady({
            runId: lease.runId,
            executionNumber: lease.executionNumber,
          });
      });
    },
    async output(identity, ref, sequence, stream, chunk) {
      const digest = createHash("sha256").update(`${stream}\0${chunk}`).digest("hex");
      const steps: RunStepEvent[] = [];
      const accepted = await dispatch.access(identity, ref, async (scope) => {
        const { executionState: state, lease, store } = scope;
        if (state === null) throw new ExecutionLeaseError();
        if (sequence === state.sequence && digest === state.digest)
          return { lease, settled: "", ended: null };
        if (sequence !== state.sequence + 1)
          throw new Error("Execution output sequence is out of order.");
        const bytes = state[stream].bytes + Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) {
          const error = new AutomationRuntimeError(
            "PROCESS_OUTPUT_LIMIT_EXCEEDED",
            `Execution output exceeded ${MAX_OUTPUT_BYTES} bytes.`,
          );
          return { lease, settled: "", ended: await end(scope, null, { error }) };
        }
        const { settled, pending } = createRunOutputRedactor(state.redacted).settle(
          state[stream].pending + chunk,
        );
        const read =
          stream === "stderr"
            ? readExecutionSignals(state.signals, state.line, chunk, new Date().toISOString())
            : state;
        let failure: unknown = null;
        if (lease.runId !== null) {
          if (settled !== "")
            await store.appendRunExecutionOutput({
              executionNumber: lease.executionNumber,
              runId: lease.runId,
              [stream]: settled,
            });
          if (stream === "stderr") {
            const applied = await applyRunEvents({
              chunk,
              lease,
              line: state.line,
              onStep: (step) => steps.push(step),
              run: await getRunOrThrow(store, lease.runId),
              store,
            });
            failure = applied.failed?.error ?? null;
          }
        }
        const next: ExecutionState = {
          ...state,
          sequence,
          digest,
          [stream]: { bytes, pending },
          line: read.line,
          signals: read.signals,
        };
        if (failure !== null)
          return { lease, settled, ended: await end(scope, null, { error: failure }, next) };
        await scope.save(next);
        return { lease, settled, ended: null };
      });
      const { lease } = accepted;
      if (lease.runId !== null) {
        if (accepted.settled !== "")
          publish({
            type: "chunk",
            runId: lease.runId,
            executionNumber: lease.executionNumber,
            chunk: accepted.settled,
            stream,
            timestamp: new Date().toISOString(),
          });
        for (const step of steps) publishStep(step, lease.runId);
      }
      if (accepted.ended === null) return;
      announce(accepted.ended);
      throw new ExecutionLeaseError();
    },
    async complete(identity, ref, report) {
      const digest = createHash("sha256")
        .update(
          JSON.stringify({
            exitCode: report.exitCode,
            stdout: report.stdout,
            stderr: report.stderr,
            durationMs: report.durationMs,
            failure: report.failure,
            phases: report.phases,
          }),
        )
        .digest("hex");
      if (await dispatch.completed(identity, ref, digest)) return;
      const tooLarge =
        Buffer.byteLength(report.stdout) > MAX_OUTPUT_BYTES ||
        Buffer.byteLength(report.stderr) > MAX_OUTPUT_BYTES;
      await finish(
        identity,
        ref,
        digest,
        tooLarge
          ? {
              error: new AutomationRuntimeError(
                "PROCESS_OUTPUT_LIMIT_EXCEEDED",
                `Execution report exceeded ${MAX_OUTPUT_BYTES} bytes per stream.`,
              ),
            }
          : report,
      );
    },
  };
}
