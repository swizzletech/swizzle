import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { context as otContext, propagation } from "@opentelemetry/api";
import { getTracer } from "@swizzle/core";
import type { ExecutionLease } from "@swizzle/db";
import type { AutomationRuntimeErrorCode } from "./errors.js";
import type { ExecutionProtocol } from "./execution-protocol.js";
import { platformBaseEnvironment } from "./platform-secrets.js";
import type { AutomationRunResult } from "./run-result.js";
import type { RunAutomationOptions } from "./runner.js";
import {
  type ExecutionAssignment,
  type ExecutionReport,
  type ExecutionSecrets,
  type ExecutionSource,
  MAX_FAILURE_DETAIL_LENGTH,
  MAX_FAILURE_MESSAGE_LENGTH,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
} from "./worker-wire.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** What the server keeps for one prepared execution until its lease ends. */
export interface ExecutionDelivery {
  readonly assignment: ExecutionAssignment;
  readonly source: ExecutionSource;
  readonly secrets: ExecutionSecrets;
}
/**
 * The execution-scoped worker routes as one accepted execution sees them. Each call carries the
 * execution's lease, so the server answers only for the execution the worker owns now.
 */
export interface ExecutionChannel {
  /** `POST /worker/source`: the bundle. Repeatable while the lease lives. */
  source(): Promise<ExecutionSource>;
  /** `POST /worker/start`: records the start and returns the secrets. Repeatable. */
  start(): Promise<ExecutionSecrets>;
  /** `POST /worker/ready`: preparation ended; the process can start. Repeatable. */
  ready(): Promise<void>;
  /** `POST /worker/output`: one ordered chunk, acknowledged after durable processing. */
  output(stream: "stdout" | "stderr", chunk: string): Promise<void>;
}
const reportExecution = (result: AutomationRunResult): ExecutionReport => ({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  durationMs: result.durationMs,
  ...(result.phases === undefined ? {} : { phases: result.phases }),
  failure: result.success
    ? null
    : {
        code: result.code,
        message: result.message.slice(0, MAX_FAILURE_MESSAGE_LENGTH),
        signal: result.signal,
        ...(result.cause === undefined
          ? {}
          : { cause: result.cause?.slice(0, MAX_FAILURE_DETAIL_LENGTH) ?? null }),
        ...(result.stack === undefined
          ? {}
          : { stack: result.stack?.slice(0, MAX_FAILURE_DETAIL_LENGTH) ?? null }),
      },
});

/** Source transfer has no archive links or extraction semantics. Every file is bounded and hashed. */
export async function readExecutionSource(directory: string): Promise<ExecutionSource> {
  const files: ExecutionSource = [];
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(directory, relative))) {
      const name = relative === "" ? entry : `${relative}/${entry}`;
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("Execution source cannot contain links.");
      if (info.isDirectory()) {
        await visit(name);
        continue;
      }
      if (
        !info.isFile() ||
        info.size + bytes > MAX_SOURCE_BYTES ||
        files.length >= MAX_SOURCE_FILES
      )
        throw new Error("Execution source exceeds file or size limits.");
      const content = await readFile(absolute);
      bytes += content.byteLength;
      files.push({
        path: name,
        data: content.toString("base64"),
        sha256: digest(content),
        executable: (info.mode & 0o111) !== 0,
      });
    }
  };
  await visit("");
  return files;
}

/** Server side: splits prepared options into the pull reply, the bundle and the secrets. */
export async function createExecutionDelivery(
  lease: ExecutionLease,
  script: "run" | "check",
  options: RunAutomationOptions,
): Promise<ExecutionDelivery> {
  const source = await readExecutionSource(options.automationDirectory);
  const traceContext: Record<string, string> = {};
  propagation.inject(otContext.active(), traceContext);
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.environment ?? {}))
    if (value !== undefined) secrets[name] = value;
  return {
    source,
    secrets,
    assignment: {
      traceContext,
      lease,
      script,
      sourceSha256: sourceDigest(source),
      options: {
        ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
        environmentName: options.environmentName,
        ...(options.executionNumber === undefined
          ? {}
          : { executionNumber: options.executionNumber }),
        ...(options.grantMaxTimeoutMs === undefined
          ? {}
          : { grantMaxTimeoutMs: options.grantMaxTimeoutMs }),
        ...(options.inlineJson === undefined ? {} : { inlineJson: options.inlineJson }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.runtimeMetadata === undefined
          ? {}
          : { runtimeMetadata: options.runtimeMetadata }),
        ...(options.stateSnapshot === undefined ? {} : { stateSnapshot: options.stateSnapshot }),
        ...(options.stepsSnapshot === undefined ? {} : { stepsSnapshot: options.stepsSnapshot }),
        ...(options.triggerType === undefined ? {} : { triggerType: options.triggerType }),
        ...(options.webhookContext === undefined ? {} : { webhookContext: options.webhookContext }),
      },
    },
  };
}

/** The digest a worker checks a fetched bundle against: paths, contents and modes. */
function sourceDigest(source: ExecutionSource): string {
  const manifest = source
    .map((file) => `${file.path}\0${file.sha256}\0${file.executable ? "x" : "-"}\n`)
    .sort();
  return createHash("sha256").update(manifest.join("")).digest("hex");
}

export async function withExecutionSource<T>(
  files: ExecutionSource,
  use: (directory: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-execution-"));
  try {
    let bytes = 0;
    if (files.length > MAX_SOURCE_FILES) throw new Error("Too many execution files.");
    const seen = new Set<string>();
    for (const file of files) {
      signal?.throwIfAborted();
      if (
        file.path.includes("\\") ||
        file.path.includes("\0") ||
        file.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
        path.isAbsolute(file.path) ||
        seen.has(file.path)
      )
        throw new Error("Invalid execution source path.");
      seen.add(file.path);
      const content = Buffer.from(file.data, "base64");
      bytes += content.byteLength;
      if (bytes > MAX_SOURCE_BYTES || digest(content) !== file.sha256)
        throw new Error("Execution source size or digest mismatch.");
      const target = path.join(directory, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    }
    signal?.throwIfAborted();
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Fetches and checks the bundle, starts the execution, then runs it with this machine's executor. */
export async function executeAssignment(input: {
  readonly assignment: ExecutionAssignment;
  readonly channel: ExecutionChannel;
  readonly executor: ExecutionProtocol;
  /** The executing machine's own environment: its policy and the child's allowlisted base. */
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}): Promise<ExecutionReport> {
  input.signal.throwIfAborted();
  return await otContext.with(
    propagation.extract(otContext.active(), input.assignment.traceContext),
    () =>
      getTracer("@swizzle/runtime").startActiveSpan(
        "automation.process",
        {
          attributes: {
            "automation.run_id": input.assignment.lease.runId ?? "",
            "worker.id": input.assignment.lease.workerId,
          },
        },
        async (span) => {
          try {
            const source = await input.channel.source();
            if (sourceDigest(source) !== input.assignment.sourceSha256)
              throw new Error("Execution source does not match its assignment.");
            return await withExecutionSource(
              source,
              async (directory) => {
                // Secrets arrive only once the bundle is staged, just before the process starts.
                const secrets = await input.channel.start();
                input.signal.throwIfAborted();
                const options: RunAutomationOptions = {
                  ...input.assignment.options,
                  automationDirectory: directory,
                  // The server sends only injected values; this machine supplies the base.
                  environment: { ...platformBaseEnvironment(input.environment), ...secrets },
                  policyEnvironment: input.environment,
                  abortSignal: input.signal,
                  onReady: () => input.channel.ready(),
                  onStdoutChunk: (chunk) => input.channel.output("stdout", chunk),
                  onStderrChunk: (chunk) => input.channel.output("stderr", chunk),
                };
                return reportExecution(await input.executor[input.assignment.script](options));
              },
              input.signal,
            );
          } finally {
            span.end();
          }
        },
      ),
  );
}

const FAILURE_CODES = [
  "UPSTREAM_CONTRACT_CHANGED",
  "MISSING_REQUIRED_SECRETS",
  "PLATFORM_CONFIG_INVALID",
  "UNEXPECTED_RUNTIME_ERROR",
  "AUTOMATION_CONFIG_INVALID",
  "AUTOMATION_CONFIG_NOT_FOUND",
  "AUTOMATION_ENTRYPOINT_NOT_FOUND",
  "AUTOMATION_ENTRYPOINT_OUTSIDE_DIRECTORY",
  "AUTOMATION_ENTRYPOINT_UNSUPPORTED",
  "LANGUAGE_RUNTIME_UNAVAILABLE",
  "DEPENDENCY_CACHE_DIR_MISSING",
  "DEPENDENCY_MANIFEST_MISSING",
  "RUNTIME_CONTAINER_LIMIT_EXCEEDS_MAX",
  "TIMEOUT_FORMAT_INVALID",
  "RUN_CANCELLED",
  "PROCESS_TIMEOUT",
  "PROCESS_OUTPUT_LIMIT_EXCEEDED",
  "PROCESS_SIGNAL",
  "PROCESS_EXIT_NON_ZERO",
  "PROCESS_STDOUT_EMPTY",
  "PROCESS_STDOUT_INVALID_JSON",
  "INTERPRETER_NOT_FOUND",
  "DEPENDENCY_PACKAGING_FAILED",
  "CONTAINER_BUILD_FAILED",
  "CONTAINER_RUNTIME_UNAVAILABLE",
  "CONTAINER_IMAGE_PRUNE_INTERRUPTED",
  "DOCKER_CONTROL_TIMEOUT",
  "RUNTIME_REQUIREMENTS_UNMET",
  "RUNTIME_TIMEOUT_EXCEEDS_MAX",
  "WEBHOOK_PAYLOAD_INVALID",
] as const satisfies readonly AutomationRuntimeErrorCode[];

function isProcessSignal(value: string): value is NodeJS.Signals {
  return Object.hasOwn(os.constants.signals, value);
}

/**
 * The server derives success and JSON from stdout; a machine cannot supply an unchecked result.
 * `payload` and `runId` are the execution's own, from the server's records.
 */
export function acceptExecutionReport(
  report: ExecutionReport,
  execution: { readonly payload: unknown; readonly runId: string },
): AutomationRunResult {
  const base = {
    payload: execution.payload,
    durationMs: report.durationMs,
    runId: execution.runId,
    stdout: report.stdout,
    stderr: report.stderr,
    ...(report.phases === undefined ? {} : { phases: report.phases }),
  };
  let code: AutomationRuntimeErrorCode =
    FAILURE_CODES.find((code) => code === report.failure?.code) ?? "UNEXPECTED_RUNTIME_ERROR";
  let message = report.failure?.message ?? `Automation exited with code ${report.exitCode}.`;
  if (report.failure === null && report.exitCode === 0) {
    try {
      const result: unknown = JSON.parse(report.stdout.trim());
      return { ...base, success: true, exitCode: 0, result };
    } catch {
      code = report.stdout.trim() === "" ? "PROCESS_STDOUT_EMPTY" : "PROCESS_STDOUT_INVALID_JSON";
      message = "Automation stdout must contain valid JSON.";
    }
  }
  const signal = report.failure?.signal;
  return {
    ...base,
    success: false,
    code,
    message,
    exitCode: report.exitCode,
    signal: signal !== undefined && signal !== null && isProcessSignal(signal) ? signal : null,
    ...(report.failure?.cause === undefined ? {} : { cause: report.failure.cause }),
    ...(report.failure?.stack === undefined ? {} : { stack: report.failure.stack }),
  };
}
