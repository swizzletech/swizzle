import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as tarCreate } from "tar";
import { BoundedOutput } from "./bounded-output.js";
import { DockerScope, dockerCliEnvironment, withLocalDockerStack } from "./docker-cli.js";
import { AutomationRuntimeError, getErrorMessage } from "./errors.js";
import type { ExecutedScript } from "./executed-script.js";
import { withLocalLlmAccess } from "./local-llm-access.js";
import { createOutputRedactor, redactRunResult } from "./output-redaction.js";
import {
  type ExecutionOutputCallback,
  executeProcess,
  parseProcessResult,
  requireProcessExit,
} from "./process-execution.js";
import { ensureRunImage, type RunImageRecipe, runImageRecipe, runImageTag } from "./run-image.js";
import { pruneRunImages } from "./run-image-prune.js";
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
const SANDBOX_GRACE_MS = 60_000;

export interface RunContainerAutomationOptions {
  readonly abortSignal?: AbortSignal;
  readonly automationDirectory: string;
  readonly definition: AutomationDefinition;
  readonly environment: Record<string, string>;
  readonly onReady?: () => Promise<void>;
  readonly onStderrChunk?: ExecutionOutputCallback;
  readonly onStdoutChunk?: ExecutionOutputCallback;
  readonly outputLimitBytes?: number;
  readonly platformRun: boolean;
  readonly policyEnvironment?: NodeJS.ProcessEnv;
  readonly runId: string;
  readonly script: ExecutedScript;
  readonly timeoutMs: number;
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
          onStderrChunk: (chunk, delivery) => options.onStderrChunk?.(stderr.push(chunk), delivery),
          onStdoutChunk: (chunk, delivery) => options.onStdoutChunk?.(stdout.push(chunk), delivery),
          flushOutput: async (delivery) => {
            await options.onStderrChunk?.(stderr.end(), delivery);
            delivery.throwIfAborted();
            await options.onStdoutChunk?.(stdout.end(), delivery);
          },
          outputLimitBytes,
          stderrLimitBytes: outputLimitBytes - Buffer.byteLength(preparationStderr.value),
          sandbox,
          timeoutMs: options.timeoutMs,
        });
        phases.process = Date.now() - processStartedAt;

        const result = parseProcessResult({
          durationMs: Date.now() - startedAt,
          execution,
          messages: {
            timeout: "Container execution timed out.",
            signalPrefix: "Container terminated by",
            exitSubject: "Container",
            emptyStdout: "Container produced no stdout output.",
            invalidStdoutPrefix: "Container stdout is not valid JSON",
          },
          outputLimitBytes,
          payload: options.script.payload,
          runId: options.runId,
        });
        return redactRunResult(
          {
            ...result,
            ...(!result.success ? { definition: options.definition } : {}),
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
    if (!options.platformRun && phases.image !== undefined) {
      await pruneRunImages({ keep: new Set() }).catch(() => undefined);
    }
  }
}

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

function scriptCommand(recipe: RunImageRecipe, script: ExecutedScript): string[] {
  return [...recipe.command.slice(0, -1), `/automation/${script.relativePath}`];
}

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
  readonly flushOutput: (signal: AbortSignal) => Promise<void>;
  readonly onStderrChunk?: ExecutionOutputCallback;
  readonly onStdoutChunk?: ExecutionOutputCallback;
  readonly outputLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly sandbox: Sandbox;
  readonly timeoutMs: number;
}) {
  const containerError = (message: string, error: unknown) =>
    new AutomationRuntimeError(
      "CONTAINER_RUNTIME_UNAVAILABLE",
      `${message}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  const execution = await executeProcess({
    abortSignal: input.abortSignal,
    flushOutput: input.flushOutput,
    onStderrChunk: input.onStderrChunk,
    onStdoutChunk: input.onStdoutChunk,
    outputLimitBytes: input.outputLimitBytes,
    stderrLimitBytes: input.stderrLimitBytes,
    timeoutMs: input.timeoutMs,
    start: () =>
      spawn("docker", sandboxExecArguments(input.sandbox.name, input.environment, input.command), {
        detached: process.platform !== "win32",
        env: dockerCliEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    startError: (error) => containerError("Could not invoke the container runtime", error),
    inputError: (error) => containerError("Could not send the run inputs to the container", error),
    sendInput: (stdin, fail) => {
      const archive = tarCreate({ cwd: input.inputDirectory, portable: true }, ["."]);
      archive.on("error", (error: unknown) =>
        fail(containerError("Could not pack the run inputs", error)),
      );
      archive.pipe(stdin);
    },
    termination: {
      kind: "sandbox",
      exitGraceMs: 1_000,
      stopSandbox: () => stopSandboxBestEffort(input.sandbox),
    },
  });
  return requireProcessExit(execution);
}

async function stopSandboxBestEffort(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.docker.run(["stop", "--time", "1", sandbox.name], { outputLimitBytes: 4096 });
  } catch {
    try {
      await sandbox.docker.run(["kill", sandbox.name], { outputLimitBytes: 4096 });
    } catch {
      return;
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
