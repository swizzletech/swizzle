// A run in a sandbox container (ADR 0006): make sure the deployment's run image exists, claim a
// started sandbox for it, then stage the inputs and run the automation with one `docker exec`.
// The sandbox is removed in the background after the run, so removal is not part of its time.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as tarCreate } from "tar";
import { contractChangeFailure } from "./api-signals.js";
import { BoundedOutput } from "./bounded-output.js";
import {
  DockerScope,
  dockerCliEnvironment,
  killDockerProcess,
  withLocalDockerStack,
} from "./docker-cli.js";
import { AutomationRuntimeError, getErrorMessage } from "./errors.js";
import type { ExecutedScript } from "./executed-script.js";
import { withLocalLlmAccess } from "./local-llm-access.js";
import { createOutputRedactor, redactRunResult } from "./output-redaction.js";
import {
  ensureRunImage,
  pruneRunImages,
  type RunImageRecipe,
  runImageRecipe,
  runImageTag,
} from "./run-image.js";
import type { AutomationRunFailure, AutomationRunResult, RunPhases } from "./run-result.js";
import {
  claimSandbox,
  discardSandbox,
  prewarmSandbox,
  runEgressEnvironment,
  type Sandbox,
  sandboxSpec,
} from "./sandbox.js";
import type { AutomationDefinition } from "./validation.js";

const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
/** How much longer than the run's timeout a sandbox lives, for staging and stopping it. */
const SANDBOX_GRACE_MS = 60_000;
/** How long the exec may take to end once its sandbox was stopped, before the worker kills it. */
const EXEC_CLOSE_GRACE_MS = 1_000;

export interface RunContainerAutomationOptions {
  readonly abortSignal?: AbortSignal;
  readonly automationDirectory: string;
  readonly definition: AutomationDefinition;
  readonly environment: Record<string, string>;
  /** Image, dependencies and sandbox are ready; the process timeout has not started. */
  readonly onReady?: () => Promise<void>;
  readonly onStderrChunk?: (chunk: string) => void | Promise<void>;
  readonly onStdoutChunk?: (chunk: string) => void | Promise<void>;
  readonly outputLimitBytes?: number;
  /** A worker's run: it keeps a standby sandbox for the deployment's next run. */
  readonly platformRun: boolean;
  readonly policyEnvironment?: NodeJS.ProcessEnv;
  readonly runId: string;
  /** What the sandbox executes, in the deployment's run image, and the inputs it receives. */
  readonly script: ExecutedScript;
  readonly timeoutMs: number;
}

interface ExecutionOutcome {
  readonly aborted: boolean;
  readonly exitCode: number | null;
  readonly outputLimitExceeded: "stderr" | "stdout" | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export async function runContainerAutomation(
  options: RunContainerAutomationOptions,
): Promise<AutomationRunResult> {
  return options.platformRun
    ? await executeContainerAutomation(options)
    : await withLocalDockerStack(() => executeContainerAutomation(options));
}

async function executeContainerAutomation(
  options: RunContainerAutomationOptions,
): Promise<AutomationRunResult> {
  const startedAt = Date.now();
  const outputLimitBytes = normalizeOutputLimitBytes(options.outputLimitBytes);
  const preparationStderr = new BoundedOutput(outputLimitBytes);
  const phases: { -readonly [Phase in keyof RunPhases]: RunPhases[Phase] } = {};
  if (options.abortSignal?.aborted)
    throw new AutomationRuntimeError("RUN_CANCELLED", "Run cancelled by user.");
  const inputDirectory = await createRunInputDirectory(options.script);
  try {
    const recipe = runImageRecipe(options.definition);
    let preparationOutput = Promise.resolve();
    const image = await prepareImage(options.automationDirectory, recipe, (chunk) => {
      const accepted = preparationStderr.append(chunk);
      preparationOutput = preparationOutput.then(() => options.onStderrChunk?.(accepted));
      void preparationOutput.catch(() => {});
      if (preparationStderr.exceeded) {
        throw new AutomationRuntimeError(
          "PROCESS_OUTPUT_LIMIT_EXCEEDED",
          `Image assembly stderr exceeded ${outputLimitBytes} bytes.`,
        );
      }
    }).finally(() => preparationOutput);
    if (options.abortSignal?.aborted)
      throw new AutomationRuntimeError("RUN_CANCELLED", "Run cancelled by user.");
    if (image.assembledMs !== null) phases.image = image.assembledMs;

    const claimedAt = Date.now();
    const sandbox = await claimSandbox(sandboxSpec(options.definition, image.tag), {
      lifetimeMs: options.timeoutMs + SANDBOX_GRACE_MS,
      replace: options.platformRun,
    });
    phases.sandbox = Date.now() - claimedAt;
    phases.standby = sandbox.standby;

    return await withLocalLlmAccess(
      {
        definition: options.definition,
        environment: options.policyEnvironment ?? process.env,
        runId: options.runId,
        ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
      },
      async (serviceEnvironment, signal) => {
        await options.onReady?.();
        const redactor = createOutputRedactor(
          Object.values(serviceEnvironment).filter(
            (value) => value !== serviceEnvironment.SWIZZLE_LOCAL_LLM_URL,
          ),
        );
        const stderr = redactor.stream();
        const stdout = redactor.stream();
        const processStartedAt = Date.now();
        const execution = await executeInSandbox({
          ...(signal === undefined ? {} : { abortSignal: signal }),
          command: scriptCommand(recipe, options.script),
          environment: {
            ...options.environment,
            ...serviceEnvironment,
            ...(options.definition.config.runtime.permissions.network
              ? runEgressEnvironment(options.definition)
              : {}),
            ...runtimeEnvironment(options.script),
          },
          inputDirectory,
          onStderrChunk: (chunk) => options.onStderrChunk?.(stderr.push(chunk)),
          onStdoutChunk: (chunk) => options.onStdoutChunk?.(stdout.push(chunk)),
          outputLimitBytes,
          stderrLimitBytes: outputLimitBytes - Buffer.byteLength(preparationStderr.value),
          sandbox,
          timeoutMs: options.timeoutMs,
        });
        phases.process = Date.now() - processStartedAt;

        await options.onStderrChunk?.(stderr.end());
        await options.onStdoutChunk?.(stdout.end());
        return redactRunResult(
          {
            ...parseExecutionResult({
              definition: options.definition,
              durationMs: Date.now() - startedAt,
              execution,
              outputLimitBytes,
              payload: options.script.payload,
              runId: options.runId,
            }),
            stderr: preparationStderr.value + execution.stderr,
            phases,
          },
          redactor,
        );
      },
    ).finally(() => discardSandbox(sandbox));
  } catch (error) {
    return {
      ...createContainerFailure({
        code: error instanceof AutomationRuntimeError ? error.code : "UNEXPECTED_RUNTIME_ERROR",
        definition: options.definition,
        durationMs: Date.now() - startedAt,
        message: getErrorMessage(error),
        payload: options.script.payload,
        runId: options.runId,
      }),
      stderr: preparationStderr.value,
      phases,
    };
  } finally {
    await rm(inputDirectory, { force: true, recursive: true });
    // A local run that assembled an image prunes the older ones. A worker prunes from its
    // deployment preparation instead, which knows the images of the active deployments.
    if (!options.platformRun && phases.image !== undefined) {
      await pruneRunImages({ keep: new Set() }).catch(() => undefined);
    }
  }
}

/**
 * Prepares a deployment before its first run: assembles its run image, and with `standby` starts
 * a sandbox for that run. A worker calls it when it first sees an active deployment.
 */
export async function prepareContainerAutomation(input: {
  readonly automationDirectory: string;
  readonly definition: AutomationDefinition;
  readonly onLog?: (chunk: string) => void;
  readonly standby: boolean;
  readonly timeoutMs: number;
}): Promise<void> {
  const image = await prepareImage(
    input.automationDirectory,
    runImageRecipe(input.definition),
    input.onLog,
  );
  if (input.standby) {
    await prewarmSandbox(
      sandboxSpec(input.definition, image.tag),
      input.timeoutMs + SANDBOX_GRACE_MS,
    );
  }
}

export async function isDockerAvailable(): Promise<boolean> {
  const docker = new DockerScope({ timeoutMs: 5_000, containerName: null });
  try {
    await docker.run(["version", "--format", "{{.Server.Version}}"], { outputLimitBytes: 4096 });
    return true;
  } catch {
    return false;
  } finally {
    await docker.close();
  }
}

/** The run image's tag, and how long assembling it took when it did not exist yet. */
async function prepareImage(
  automationDirectory: string,
  recipe: RunImageRecipe,
  onLog: ((chunk: string) => void) | undefined,
): Promise<{ readonly tag: string; readonly assembledMs: number | null }> {
  const tag = await runImageTag(automationDirectory, recipe);
  const startedAt = Date.now();
  const outcome = await ensureRunImage({
    automationDirectory,
    recipe,
    tag,
    ...(onLog !== undefined ? { onLog } : {}),
  });
  return { assembledMs: outcome === "assembled" ? Date.now() - startedAt : null, tag };
}

/** Writes the files the script reads from /run/swizzle, the payload included. */
async function createRunInputDirectory(script: ExecutedScript): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "swizzle-container-input-"));
  const write = (name: string, value: unknown) =>
    writeFile(
      path.join(directory, name),
      value === undefined ? "" : `${JSON.stringify(value)}\n`,
      "utf8",
    );
  await Promise.all([
    write("payload.json", script.payload),
    ...(script.persistence === null
      ? []
      : [
          write("state.json", script.persistence.state),
          write("steps.json", script.persistence.steps),
        ]),
    ...(script.webhookContext === null
      ? []
      : [
          writeFile(
            path.join(directory, "webhook-body.bin"),
            Buffer.from(script.webhookContext.rawBodyBase64, "base64"),
          ),
        ]),
  ]);
  return directory;
}

function runtimeEnvironment(script: ExecutedScript): Record<string, string> {
  const values: Record<string, string> = { SWIZZLE_RUN_TMP: "/tmp" };
  if (script.persistence !== null) {
    values.SWIZZLE_STATE_FILE = "/run/swizzle/state.json";
    values.SWIZZLE_STEPS_FILE = "/run/swizzle/steps.json";
  }
  if (script.webhookContext !== null) {
    values.SWIZZLE_WEBHOOK_HEADERS = JSON.stringify(script.webhookContext.headers);
    values.SWIZZLE_WEBHOOK_RAW_BODY_PATH = "/run/swizzle/webhook-body.bin";
    values.SWIZZLE_WEBHOOK_RAW_BODY_SHA256 = script.webhookContext.rawBodySha256;
  }
  return values;
}

/**
 * The recipe's command with the script in place of the entrypoint, which is the recipe's last
 * argument. Every script runs in the run image: the check script is part of the bundle too.
 */
function scriptCommand(recipe: RunImageRecipe, script: ExecutedScript): string[] {
  return [...recipe.command.slice(0, -1), `/automation/${script.relativePath}`];
}

/**
 * The `docker exec` of a run: the shell unpacks the inputs into /run/swizzle and replaces itself
 * with the automation, which reads the payload on stdin.
 */
export function sandboxExecArguments(
  sandboxName: string,
  environment: Record<string, string>,
  command: readonly string[],
): string[] {
  return [
    "exec",
    "--interactive",
    ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    sandboxName,
    "/bin/sh",
    "-c",
    'tar -xf - -C /run/swizzle && exec "$@" < /run/swizzle/payload.json',
    "swizzle-run",
    ...command,
  ];
}

async function executeInSandbox(input: {
  readonly abortSignal?: AbortSignal;
  readonly command: readonly string[];
  readonly environment: Record<string, string>;
  readonly inputDirectory: string;
  readonly onStderrChunk?: (chunk: string) => void | Promise<void>;
  readonly onStdoutChunk?: (chunk: string) => void | Promise<void>;
  readonly outputLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly sandbox: Sandbox;
  readonly timeoutMs: number;
}): Promise<ExecutionOutcome> {
  return await new Promise((resolve, reject) => {
    if (input.abortSignal?.aborted)
      throw new AutomationRuntimeError("RUN_CANCELLED", "Run cancelled by user.");
    const child = spawn(
      "docker",
      sandboxExecArguments(input.sandbox.name, input.environment, input.command),
      {
        detached: process.platform !== "win32",
        env: dockerCliEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let callbacks = Promise.resolve();
    let callbackFailure: unknown;
    const deliver = (
      stream: typeof child.stdout,
      callback: ((chunk: string) => void | Promise<void>) | undefined,
      chunk: string,
    ) => {
      if (callback === undefined) return;
      stream.pause();
      callbacks = callbacks
        .then(async () => {
          if (callbackFailure === undefined) await callback(chunk);
        })
        .catch((error) => {
          callbackFailure = error;
          stop("aborted");
        })
        .finally(() => stream.resume());
    };
    const stdout = new BoundedOutput(input.outputLimitBytes);
    const stderr = new BoundedOutput(input.stderrLimitBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let stopping = false;
    let forceKill: NodeJS.Timeout | undefined;
    let outputLimitExceeded: "stderr" | "stdout" | null = null;

    // Stopping the sandbox ends the exec, unless the daemon no longer answers it. Stop and kill
    // have deadlines, so once both have returned and the grace has passed, the CLI is killed here.
    const stop = (reason: "aborted" | "timeout" | "stderr" | "stdout") => {
      if (reason === "aborted") aborted = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "stderr" || reason === "stdout") outputLimitExceeded = reason;
      if (stopping) return;
      stopping = true;
      void stopContainer(input.sandbox).then(() => {
        if (!settled) forceKill = setTimeout(() => killDockerProcess(child), EXEC_CLOSE_GRACE_MS);
      });
    };
    const timeout = setTimeout(() => stop("timeout"), input.timeoutMs);
    const abort = () => stop("aborted");
    if (input.abortSignal?.aborted) abort();
    else input.abortSignal?.addEventListener("abort", abort, { once: true });
    const settle = () => {
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      input.abortSignal?.removeEventListener("abort", abort);
    };

    const append = (stream: "stderr" | "stdout", chunk: string) => {
      if (stopping) return;
      const output = stream === "stdout" ? stdout : stderr;
      const accepted = output.append(chunk);
      if (accepted) {
        if (stream === "stdout") deliver(child.stdout, input.onStdoutChunk, accepted);
        else deliver(child.stderr, input.onStderrChunk, accepted);
      }
      if (output.exceeded) stop(stream);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: string) => append("stderr", chunk));
    const fail = (message: string, error: unknown) => {
      if (settled) return;
      settle();
      reject(
        new AutomationRuntimeError(
          "CONTAINER_RUNTIME_UNAVAILABLE",
          `${message}: ${getErrorMessage(error)}`,
          { cause: error },
        ),
      );
    };
    child.once("error", (error) => fail("Could not invoke the container runtime", error));
    child.once("close", (exitCode, signal) => {
      void callbacks.then(() => {
        if (settled) return;
        settle();
        if (callbackFailure !== undefined) {
          reject(callbackFailure);
          return;
        }
        resolve({
          aborted,
          exitCode,
          outputLimitExceeded,
          signal,
          stderr: stderr.value,
          stdout: stdout.value,
          timedOut,
        });
      });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") return;
      fail("Could not send the run inputs to the container", error);
    });
    const archive = tarCreate({ cwd: input.inputDirectory, portable: true }, ["."]);
    archive.on("error", (error: unknown) => fail("Could not pack the run inputs", error));
    archive.pipe(child.stdin);
  });
}

function parseExecutionResult(input: {
  readonly definition: AutomationDefinition;
  readonly durationMs: number;
  readonly execution: ExecutionOutcome;
  readonly outputLimitBytes: number;
  readonly payload: unknown;
  readonly runId: string;
}): AutomationRunResult {
  const common = {
    definition: input.definition,
    durationMs: input.durationMs,
    exitCode: input.execution.exitCode,
    payload: input.payload,
    runId: input.runId,
    signal: input.execution.signal,
    stderr: input.execution.stderr,
    stdout: input.execution.stdout,
  };
  if (input.execution.aborted) {
    return { ...common, code: "RUN_CANCELLED", message: "Run cancelled by user.", success: false };
  }
  if (input.execution.timedOut) {
    return {
      ...common,
      code: "PROCESS_TIMEOUT",
      message: "Container execution timed out.",
      success: false,
    };
  }
  if (input.execution.outputLimitExceeded !== null) {
    return {
      ...common,
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      message: `Automation ${input.execution.outputLimitExceeded} exceeded ${input.outputLimitBytes} bytes.`,
      success: false,
    };
  }
  if (input.execution.signal !== null) {
    return {
      ...common,
      code: "PROCESS_SIGNAL",
      message: `Container terminated by ${input.execution.signal}.`,
      success: false,
    };
  }
  if (input.execution.exitCode !== 0) {
    return {
      ...common,
      code: "PROCESS_EXIT_NON_ZERO",
      message: `Container exited with code ${input.execution.exitCode}.`,
      ...contractChangeFailure(input.execution.stderr),
      success: false,
    };
  }
  const stdout = input.execution.stdout.trim();
  if (stdout.length === 0) {
    return {
      ...common,
      code: "PROCESS_STDOUT_EMPTY",
      message: "Container produced no stdout output.",
      success: false,
    };
  }
  try {
    return {
      durationMs: input.durationMs,
      exitCode: 0,
      payload: input.payload,
      result: JSON.parse(stdout) as unknown,
      runId: input.runId,
      stderr: input.execution.stderr,
      stdout: input.execution.stdout,
      success: true,
    };
  } catch (error) {
    return {
      ...common,
      code: "PROCESS_STDOUT_INVALID_JSON",
      message: `Container stdout is not valid JSON: ${getErrorMessage(error)}`,
      success: false,
    };
  }
}

async function stopContainer(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.docker.run(["stop", "--time", "1", sandbox.name], { outputLimitBytes: 4096 });
  } catch {
    try {
      await sandbox.docker.run(["kill", sandbox.name], { outputLimitBytes: 4096 });
    } catch {
      // The container may already have exited.
    }
  }
}

function createContainerFailure(input: {
  readonly code: AutomationRunFailure["code"];
  readonly definition: AutomationDefinition;
  readonly durationMs: number;
  readonly message: string;
  readonly payload: unknown;
  readonly runId: string;
}): AutomationRunFailure {
  return {
    code: input.code,
    durationMs: input.durationMs,
    exitCode: null,
    message: input.message,
    payload: input.payload,
    runId: input.runId,
    signal: null,
    stderr: "",
    stdout: "",
    success: false,
  };
}

function normalizeOutputLimitBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_OUTPUT_LIMIT_BYTES;
  return Math.max(1, Math.floor(value));
}
