import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { addAbortListener } from "node:events";
import type { Writable } from "node:stream";
import { contractChangeFailure } from "./api-signals.js";
import { killDockerProcess } from "./docker-cli.js";
import { AutomationRuntimeError, getErrorMessage } from "./errors.js";
import { OutputPump } from "./output-pump.js";
import type { AutomationRunFailure, AutomationRunResult } from "./run-result.js";

interface ProcessOutput {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

type Termination = { readonly exitGraceMs: number } & (
  | {
      readonly kind: "host";
      readonly signals: {
        readonly graceful: NodeJS.Signals;
        readonly force: NodeJS.Signals;
        readonly abortGraceMs: number;
      };
      readonly stopSandbox?: never;
    }
  | {
      readonly kind: "sandbox";
      readonly stopSandbox: () => Promise<void>;
      readonly signals?: never;
    }
);

type ExitReason = "aborted" | "timeout" | { readonly limit: "stderr" | "stdout" };
type StopOutcome =
  | { readonly stoppedBy: ExitReason | null }
  | { readonly stoppedBy: "callback-failed"; readonly error: unknown };

const OUTPUT_FLUSH_MS = 5_000;

export type ExecutionOutputCallback = (chunk: string, signal?: AbortSignal) => void | Promise<void>;

export type ExecutionOutcome = ProcessOutput & StopOutcome;
type ProcessExit = Exclude<ExecutionOutcome, { stoppedBy: "callback-failed" }>;

export async function executeProcess(input: {
  readonly abortSignal?: AbortSignal | undefined;
  readonly start: () => ChildProcessWithoutNullStreams;
  readonly startError: (error: Error) => Error;
  readonly sendInput: (stdin: Writable, fail: (error: unknown) => void) => void;
  readonly inputError?: (error: NodeJS.ErrnoException) => Error;
  readonly termination: Termination;
  readonly onStderrChunk?: ExecutionOutputCallback | undefined;
  readonly onStdoutChunk?: ExecutionOutputCallback | undefined;
  readonly flushOutput?: (signal: AbortSignal) => void | Promise<void>;
  readonly outputLimitBytes: number;
  readonly stderrLimitBytes?: number;
  readonly timeoutMs: number;
}): Promise<ExecutionOutcome> {
  if (input.abortSignal?.aborted)
    throw new AutomationRuntimeError("RUN_CANCELLED", "Run cancelled by user.");
  const { termination } = input;
  return await new Promise((resolve, reject) => {
    const child = input.start();
    let stoppedBy: ExitReason | null = null;
    let stopping = false;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    const delivery = new AbortController();
    const startFlushBudget = () => {
      flushTimer ??= setTimeout(
        () => delivery.abort(new Error("Execution output delivery timed out.")),
        OUTPUT_FLUSH_MS,
      );
    };
    const deliver = async (callback: (signal: AbortSignal) => void | Promise<void>) => {
      if (delivery.signal.aborted) return;
      let cancel = () => {};
      const cancelled = new Promise<void>((resolve) => {
        cancel = resolve;
      });
      const listener = addAbortListener(delivery.signal, cancel);
      try {
        await Promise.race([cancelled, callback(delivery.signal)]);
        if (!delivery.signal.aborted) flushTimer?.refresh();
      } finally {
        listener[Symbol.dispose]();
      }
    };
    const chunkDelivery = (callback: ExecutionOutputCallback | undefined) =>
      callback === undefined
        ? undefined
        : (chunk: string) => deliver((signal) => callback(chunk, signal));

    const stop = (reason: NonNullable<StopOutcome["stoppedBy"]>) => {
      if (settled) return;
      if (termination.kind === "sandbox" || reason === "callback-failed") output.stop();
      if (
        reason !== "callback-failed" &&
        (stoppedBy === null ||
          reason === "aborted" ||
          (reason === "timeout" && stoppedBy !== "aborted"))
      ) {
        stoppedBy = reason;
      }
      startFlushBudget();
      if (stopping || child.exitCode !== null || child.signalCode !== null) return;
      stopping = true;
      if (termination.kind === "sandbox") {
        void termination.stopSandbox().then(() => {
          if (!settled && child.exitCode === null && child.signalCode === null) {
            forceKill = setTimeout(() => killDockerProcess(child), termination.exitGraceMs);
          }
        });
      } else {
        const { signals } = termination;
        child.kill(signals.graceful);
        forceKill = setTimeout(
          () => child.kill(signals.force),
          reason === "aborted" ? signals.abortGraceMs : termination.exitGraceMs,
        );
      }
    };
    const output = new OutputPump(child, {
      stdout: { kind: "text", onChunk: chunkDelivery(input.onStdoutChunk) },
      stdoutLimitBytes: input.outputLimitBytes,
      stderrLimitBytes: input.stderrLimitBytes ?? input.outputLimitBytes,
      onStderrChunk: chunkDelivery(input.onStderrChunk),
      limitPolicy: "stop",
      onStop: (reason) => {
        if (reason.kind === "limit") stop({ limit: reason.stream });
        if (reason.kind === "callback-failed") stop(reason.kind);
      },
    });
    const timeout = setTimeout(() => stop("timeout"), input.timeoutMs);
    const abort = () => stop("aborted");
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      clearTimeout(flushTimer);
      delivery.abort();
      input.abortSignal?.removeEventListener("abort", abort);
      finish();
    };
    const fail = (error: unknown) => settle(() => reject(error));

    child.once("error", (error) => fail(input.startError(error)));
    child.once("exit", startFlushBudget);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      startFlushBudget();
      const complete = (stopOutcome: StopOutcome) => {
        settle(() =>
          resolve({
            ...stopOutcome,
            exitCode,
            signal,
            stderr: output.stderr,
            stdout: output.stdout,
          }),
        );
      };
      void output
        .finished()
        .then(async () => {
          if (input.flushOutput !== undefined) await deliver(input.flushOutput);
          if (stoppedBy === null && delivery.signal.aborted) throw delivery.signal.reason;
          complete({ stoppedBy });
        })
        .catch((error: unknown) =>
          complete(stoppedBy === null ? { stoppedBy: "callback-failed", error } : { stoppedBy }),
        );
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") fail(input.inputError?.(error) ?? error);
    });
    if (input.abortSignal?.aborted) abort();
    else input.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      input.sendInput(child.stdin, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export function requireProcessExit(execution: ExecutionOutcome): ProcessExit {
  if (execution.stoppedBy === "callback-failed") throw execution.error;
  return execution;
}

export function parseProcessResult(input: {
  readonly execution: ProcessExit;
  readonly durationMs: number;
  readonly outputLimitBytes: number;
  readonly payload: unknown;
  readonly runId: string;
  readonly messages: {
    readonly timeout: string;
    readonly signalPrefix: string;
    readonly exitSubject: string;
    readonly emptyStdout: string;
    readonly invalidStdoutPrefix: string;
  };
}): AutomationRunResult {
  const { execution, messages } = input;
  const common = {
    durationMs: input.durationMs,
    payload: input.payload,
    runId: input.runId,
    stderr: execution.stderr,
    stdout: execution.stdout,
  };
  const failure = (code: AutomationRunFailure["code"], message: string): AutomationRunFailure => ({
    ...common,
    exitCode: execution.exitCode,
    signal: execution.signal,
    code,
    message,
    success: false,
  });

  if (execution.stoppedBy === "aborted") return failure("RUN_CANCELLED", "Run cancelled by user.");
  if (execution.stoppedBy === "timeout") {
    return failure("PROCESS_TIMEOUT", messages.timeout);
  }
  if (execution.stoppedBy !== null) {
    return failure(
      "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      `Automation ${execution.stoppedBy.limit} exceeded ${input.outputLimitBytes} bytes.`,
    );
  }
  if (execution.signal !== null) {
    return failure("PROCESS_SIGNAL", `${messages.signalPrefix} ${execution.signal}.`);
  }
  if (execution.exitCode !== 0) {
    return {
      ...failure(
        "PROCESS_EXIT_NON_ZERO",
        `${messages.exitSubject} exited with code ${execution.exitCode}.`,
      ),
      ...contractChangeFailure(execution.stderr),
    };
  }
  const stdout = execution.stdout.trim();
  if (stdout.length === 0) {
    return failure("PROCESS_STDOUT_EMPTY", messages.emptyStdout);
  }
  try {
    const result: unknown = JSON.parse(stdout);
    return { ...common, exitCode: 0, result, success: true };
  } catch (error) {
    return failure(
      "PROCESS_STDOUT_INVALID_JSON",
      `${messages.invalidStdoutPrefix}: ${getErrorMessage(error)}`,
    );
  }
}
