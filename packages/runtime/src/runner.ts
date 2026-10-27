import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateWebhookPayloadAgainstSchema } from "@swizzle/config";
import { createDisplayName } from "@swizzle/core";
import { contractChangeFailure } from "./api-signals.js";
import { runContainerAutomation } from "./container-runner.js";
import { prepareAutomationDependencies } from "./dependency-preparation.js";
import {
  AutomationRuntimeError,
  type AutomationRuntimeErrorCode,
  getErrorMessage,
} from "./errors.js";
import {
  checkScript,
  type ExecutedScript,
  entrypointScript,
  type RunInputs,
  type ScriptPersistence,
} from "./executed-script.js";
import { OutputPump } from "./output-pump.js";
import type { AutomationRunFailure, AutomationRunResult, RuntimeMetadata } from "./run-result.js";
import { buildRuntimeEnvironmentAdditions } from "./runtime-requirements.js";
import { assertRuntimeTimeoutWithinPlatformCeiling } from "./timeout-policy.js";
import { type AutomationDefinition, loadAutomationDefinition } from "./validation.js";
import { SWIZZLE_LINK_KEY_ENV, SWIZZLE_LINK_URL_ENV } from "./wait-links.js";
import { materializeWebhookRunContext } from "./webhook-context.js";

const DEFAULT_KILL_GRACE_PERIOD_MS = 1_000;
const DEFAULT_ABORT_KILL_GRACE_PERIOD_MS = 5_000;
const DEFAULT_CHILD_OUTPUT_LIMIT_BYTES = 1_048_576;

/** What every execution takes, whichever script it runs. */
export interface ExecutionOptions {
  readonly abortSignal?: AbortSignal;
  /** The retry attempt the execution spends, which the automation reads as SWIZZLE_ATTEMPT. */
  readonly attempt?: number;
  readonly automationDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** The environment the run belongs to, which the automation reads as SWIZZLE_ENV. */
  readonly environmentName: string;
  /** Which execution of the run this is, which the automation reads as SWIZZLE_EXECUTION. */
  readonly executionNumber?: number;
  /**
   * Per-automation timeout grant (ms), if one exists for this automation +
   * environment. Raises the effective `runtime.timeout` ceiling for this run.
   */
  readonly grantMaxTimeoutMs?: number | null;
  /** Image, dependencies and sandbox are ready; the process timeout has not started. */
  readonly onReady?: () => Promise<void>;
  readonly onStderrChunk?: (chunk: string) => void | Promise<void>;
  readonly onStdoutChunk?: (chunk: string) => void | Promise<void>;
  readonly outputLimitBytes?: number;
  readonly policyEnvironment?: NodeJS.ProcessEnv;
  readonly runId?: string;
  readonly runtimeMetadata?: RuntimeMetadata;
}

export interface RunAutomationOptions extends ExecutionOptions, RunInputs {}

interface ExecutionCommand {
  readonly args: string[];
  readonly command: string;
  readonly displayName: string;
}

interface ExecutionOutcome {
  readonly aborted: boolean;
  readonly exitCode: number | null;
  readonly outputLimitBytes: number;
  readonly outputLimitExceeded: "stderr" | "stdout" | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/** Runs the automation's entrypoint with a run's inputs. */
export async function runAutomation(options: RunAutomationOptions): Promise<AutomationRunResult> {
  return await execute(options, (definition) => entrypointScript(definition, options));
}

/**
 * Runs the automation's API check script (`api_check.mode: active`) in place of its entrypoint,
 * as the check contract reads it: see executed-script.ts for what the check receives.
 */
export async function runAutomationCheck(options: ExecutionOptions): Promise<AutomationRunResult> {
  return await execute(options, async (definition) => checkScript(definition));
}

async function execute(
  options: ExecutionOptions,
  resolveScript: (definition: AutomationDefinition) => Promise<ExecutedScript>,
): Promise<AutomationRunResult> {
  const startedAt = Date.now();
  let dependencyStderr = "";

  try {
    const definition = await loadAutomationDefinition(options.automationDirectory);
    const script = await resolveScript(definition);
    const payload = script.payload;

    const payloadValidation = validateWebhookPayloadAgainstSchema(script.payloadSchema, payload);
    if (!payloadValidation.ok) {
      return createFailure({
        code: "WEBHOOK_PAYLOAD_INVALID",
        durationMs: Date.now() - startedAt,
        exitCode: null,
        message: `Payload does not match trigger.payload_schema: ${payloadValidation.errors
          .map((issue) => `${issue.instancePath} ${issue.message}`)
          .join("; ")}`,
        payload,
        signal: null,
        stderr: "",
        stdout: "",
      });
    }

    const missingSecrets = getMissingSecrets(script.secrets, options.environment ?? process.env);
    if (missingSecrets.length > 0) {
      return createFailure({
        code: "MISSING_REQUIRED_SECRETS",
        durationMs: Date.now() - startedAt,
        exitCode: null,
        message: `Missing required secrets in the current environment: ${missingSecrets.join(", ")}`,
        payload,
        signal: null,
        stderr: "",
        stdout: "",
      });
    }

    const runId = options.runId ?? `local-run-${randomUUID()}`;
    const timeoutPolicy = assertRuntimeTimeoutWithinPlatformCeiling(
      definition.config.runtime.timeout,
      {
        ...(options.policyEnvironment !== undefined
          ? { environment: options.policyEnvironment }
          : {}),
        ...(options.grantMaxTimeoutMs !== undefined
          ? { grantMaxTimeoutMs: options.grantMaxTimeoutMs }
          : {}),
      },
    );

    if (runsInSandbox(definition, options.runtimeMetadata !== undefined)) {
      const runtimeEnvironment = buildRuntimeEnvironment({
        attempt: options.attempt ?? 1,
        executionNumber: options.executionNumber ?? 1,
        definition,
        environment: selectContainerAutomationEnvironment(
          script.secrets,
          options.environment ?? process.env,
        ),
        environmentName: options.environmentName,
        runId,
        ...(options.runtimeMetadata !== undefined
          ? { runtimeMetadata: options.runtimeMetadata }
          : {}),
        triggerType: script.triggerType,
      });
      return await runContainerAutomation({
        ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
        automationDirectory: definition.directory,
        definition,
        environment: compactEnvironment(runtimeEnvironment),
        ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
        ...(options.onStderrChunk !== undefined ? { onStderrChunk: options.onStderrChunk } : {}),
        ...(options.onStdoutChunk !== undefined ? { onStdoutChunk: options.onStdoutChunk } : {}),
        ...(options.outputLimitBytes !== undefined
          ? { outputLimitBytes: options.outputLimitBytes }
          : {}),
        platformRun: options.runtimeMetadata !== undefined,
        ...(options.policyEnvironment === undefined
          ? {}
          : { policyEnvironment: options.policyEnvironment }),
        runId,
        script,
        timeoutMs: timeoutPolicy.timeoutMs,
      });
    }

    let dependencyOutput = Promise.resolve();
    const dependencyPreparation = await prepareAutomationDependencies({
      automationDirectory: definition.directory,
      cacheMode: options.runtimeMetadata ? "worker" : "local",
      config: definition.config,
      environment: {
        ...(options.runtimeMetadata ? process.env : (options.environment ?? process.env)),
        ...(process.env.SWIZZLE_DEP_CACHE_DIR !== undefined
          ? { SWIZZLE_DEP_CACHE_DIR: process.env.SWIZZLE_DEP_CACHE_DIR }
          : {}),
        ...(process.env.SWIZZLE_ARTIFACTS_DIR !== undefined
          ? { SWIZZLE_ARTIFACTS_DIR: process.env.SWIZZLE_ARTIFACTS_DIR }
          : {}),
      },
      onLog: (chunk) => {
        dependencyStderr += chunk;
        dependencyOutput = dependencyOutput.then(() => options.onStderrChunk?.(chunk));
        void dependencyOutput.catch(() => {});
      },
    }).finally(() => dependencyOutput);
    if (options.abortSignal?.aborted)
      throw new AutomationRuntimeError("RUN_CANCELLED", "Run cancelled by user.");
    const executionCommand = await resolveExecutionCommand(definition, script.path);
    const webhookRuntime = await materializeWebhookRunContext(script.webhookContext);
    const scratchDirectory = await mkdtemp(path.join(os.tmpdir(), "swizzle-run-"));
    const persistenceFiles =
      script.persistence === null
        ? null
        : await writePersistenceFiles(scratchDirectory, script.persistence);
    const runtimeEnvironment = buildRuntimeEnvironment({
      attempt: options.attempt ?? 1,
      executionNumber: options.executionNumber ?? 1,
      definition,
      environment: {
        ...(options.environment ?? process.env),
        ...(webhookRuntime?.environment ?? {}),
      },
      environmentName: options.environmentName,
      runId,
      runTmp: scratchDirectory,
      ...(persistenceFiles !== null ? { persistenceFiles } : {}),
      dependencyEnvironment: dependencyPreparation.environment,
      ...(options.runtimeMetadata !== undefined
        ? { runtimeMetadata: options.runtimeMetadata }
        : {}),
      triggerType: script.triggerType,
    });

    const execution = await Promise.resolve()
      .then(async () => {
        await options.onReady?.();
        return await executeChildProcess({
          ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          command: executionCommand,
          definition,
          environment: runtimeEnvironment,
          ...(options.onStderrChunk !== undefined ? { onStderrChunk: options.onStderrChunk } : {}),
          ...(options.onStdoutChunk !== undefined ? { onStdoutChunk: options.onStdoutChunk } : {}),
          outputLimitBytes: normalizeOutputLimitBytes(options.outputLimitBytes),
          payload,
          scratchDirectory,
          timeoutMs: timeoutPolicy.timeoutMs,
        });
      })
      .finally(async () => {
        await Promise.all([
          webhookRuntime?.cleanup(),
          rm(scratchDirectory, { force: true, recursive: true }),
        ]);
      });

    if (execution.aborted) {
      return createFailure({
        code: "RUN_CANCELLED",
        durationMs: Date.now() - startedAt,
        exitCode: execution.exitCode,
        message: "Run cancelled by user.",
        payload,
        runId,
        signal: execution.signal,
        stderr: dependencyStderr + execution.stderr,
        stdout: execution.stdout,
      });
    }

    const durationMs = Date.now() - startedAt;
    if (execution.timedOut) {
      return createFailure({
        code: "PROCESS_TIMEOUT",
        durationMs,
        exitCode: execution.exitCode,
        message: `Automation exceeded timeout ${definition.config.runtime.timeout}.`,
        payload,
        runId,
        signal: execution.signal,
        stderr: dependencyStderr + execution.stderr,
        stdout: execution.stdout,
      });
    }

    if (execution.outputLimitExceeded !== null) {
      return createFailure({
        code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
        durationMs,
        exitCode: execution.exitCode,
        message: `Automation ${execution.outputLimitExceeded} exceeded ${execution.outputLimitBytes} bytes.`,
        payload,
        runId,
        signal: execution.signal,
        stderr: dependencyStderr + execution.stderr,
        stdout: execution.stdout,
      });
    }

    if (execution.signal) {
      return createFailure({
        code: "PROCESS_SIGNAL",
        durationMs,
        exitCode: execution.exitCode,
        message: `Automation terminated by signal ${execution.signal}.`,
        payload,
        runId,
        signal: execution.signal,
        stderr: dependencyStderr + execution.stderr,
        stdout: execution.stdout,
      });
    }

    if (execution.exitCode !== 0) {
      return createFailure({
        code: "PROCESS_EXIT_NON_ZERO",
        durationMs,
        exitCode: execution.exitCode,
        message: `Automation exited with code ${execution.exitCode}.`,
        ...contractChangeFailure(execution.stderr),
        payload,
        runId,
        signal: execution.signal,
        stderr: dependencyStderr + execution.stderr,
        stdout: execution.stdout,
      });
    }

    const trimmedStdout = execution.stdout.trim();
    if (trimmedStdout.length === 0) {
      return createFailure({
        code: "PROCESS_STDOUT_EMPTY",
        durationMs,
        exitCode: execution.exitCode,
        message:
          "Automation exited successfully but stdout was empty. Successful runs must print JSON to stdout.",
        payload,
        runId,
        signal: execution.signal,
        stderr: dependencyStderr + execution.stderr,
        stdout: execution.stdout,
      });
    }

    let result: unknown;
    try {
      result = JSON.parse(trimmedStdout);
    } catch (error) {
      return createFailure({
        code: "PROCESS_STDOUT_INVALID_JSON",
        durationMs,
        exitCode: execution.exitCode,
        message: `Automation exited successfully but stdout was not valid JSON: ${getErrorMessage(error)}`,
        payload,
        runId,
        signal: execution.signal,
        stderr: dependencyStderr + execution.stderr,
        stdout: execution.stdout,
      });
    }

    return {
      durationMs,
      exitCode: 0,
      payload,
      result,
      runId,
      stderr: dependencyStderr + execution.stderr,
      stdout: execution.stdout,
      success: true,
    };
  } catch (error) {
    return createFailure({
      code: error instanceof AutomationRuntimeError ? error.code : "UNEXPECTED_RUNTIME_ERROR",
      durationMs: Date.now() - startedAt,
      exitCode: null,
      message: getErrorMessage(error),
      signal: null,
      stderr: dependencyStderr,
      stdout: "",
    });
  }
}

/** Writes the state and steps a run resumes from into its scratch directory. */
async function writePersistenceFiles(
  scratchDirectory: string,
  persistence: ScriptPersistence,
): Promise<PersistenceFiles> {
  const files = {
    stateFile: path.join(scratchDirectory, "state.json"),
    stepsFile: path.join(scratchDirectory, "steps.json"),
  };
  await writeFile(files.stateFile, `${JSON.stringify(persistence.state, null, 2)}\n`, "utf8");
  await writeFile(files.stepsFile, `${JSON.stringify(persistence.steps, null, 2)}\n`, "utf8");
  return files;
}

interface PersistenceFiles {
  readonly stateFile: string;
  readonly stepsFile: string;
}

function buildRuntimeEnvironment(input: {
  readonly attempt: number;
  readonly definition: AutomationDefinition;
  readonly dependencyEnvironment?: NodeJS.ProcessEnv;
  readonly environment: NodeJS.ProcessEnv;
  readonly environmentName: string;
  readonly executionNumber: number;
  /** Absent for a script that holds no state, and in a container, which mounts its own. */
  readonly persistenceFiles?: PersistenceFiles;
  readonly runId: string;
  readonly runTmp?: string;
  readonly runtimeMetadata?: RuntimeMetadata;
  readonly triggerType: string;
}): NodeJS.ProcessEnv {
  const automationSlug = toRuntimeSegment(
    input.runtimeMetadata?.automationName ?? input.definition.config.name,
  );
  const versionSlug = toRuntimeSegment(
    input.runtimeMetadata?.version ?? input.definition.config.version,
  );
  // The runner owns both files: a script that holds state gets its own, never a parent's.
  const {
    SWIZZLE_STATE_FILE: _inheritedStateFile,
    SWIZZLE_STEPS_FILE: _inheritedStepsFile,
    ...inherited
  } = input.environment;

  return {
    ...inherited,
    ...stringifyConfigVars(input.definition.config.vars),
    ...buildRuntimeEnvironmentAdditions({
      automationDirectory: input.definition.directory,
      dependencyEnvironment: input.dependencyEnvironment,
      runtime: input.definition.config.runtime,
    }),
    SWIZZLE_ATTEMPT: String(input.attempt),
    SWIZZLE_AUTOMATION_ID: input.runtimeMetadata?.automationId ?? `local-${automationSlug}`,
    SWIZZLE_AUTOMATION_NAME: input.runtimeMetadata?.automationName ?? input.definition.config.name,
    SWIZZLE_AUTOMATION_VERSION: input.runtimeMetadata?.version ?? input.definition.config.version,
    SWIZZLE_ENV: input.environmentName,
    SWIZZLE_EXECUTION: String(input.executionNumber),
    ...(input.runtimeMetadata?.parentRunId !== undefined
      ? { SWIZZLE_PARENT_RUN_ID: input.runtimeMetadata.parentRunId }
      : {}),
    SWIZZLE_RATE_LIMITS: JSON.stringify(input.definition.config.runtime.rate_limits),
    SWIZZLE_RUN_ID: input.runId,
    ...(input.runTmp !== undefined ? { SWIZZLE_RUN_TMP: input.runTmp } : {}),
    ...(input.persistenceFiles !== undefined
      ? {
          SWIZZLE_STATE_FILE: input.persistenceFiles.stateFile,
          SWIZZLE_STEPS_FILE: input.persistenceFiles.stepsFile,
        }
      : {}),
    SWIZZLE_TRIGGER_TYPE: input.triggerType,
    SWIZZLE_VERSION_ID:
      input.runtimeMetadata?.versionId ?? `local-${automationSlug}-${versionSlug}`,
  };
}

function stringifyConfigVars(vars: Record<string, string | number | boolean>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(vars).map(([name, value]) => [name, String(value)]),
  ) as NodeJS.ProcessEnv;
}

function createFailure(input: {
  readonly code: AutomationRuntimeErrorCode;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly message: string;
  readonly payload?: unknown;
  readonly runId?: string;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}): AutomationRunFailure {
  return {
    code: input.code,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    message: input.message,
    payload: input.payload,
    runId: input.runId,
    signal: input.signal,
    stderr: input.stderr,
    stdout: input.stdout,
    success: false,
  };
}

function getMissingSecrets(secrets: readonly string[], environment: NodeJS.ProcessEnv): string[] {
  return secrets.filter((secretName) => {
    const value = environment[secretName];
    return value === undefined || value === "";
  });
}

async function resolveExecutionCommand(
  definition: AutomationDefinition,
  scriptPath: string,
): Promise<ExecutionCommand> {
  switch (definition.entrypointExtension) {
    case ".py":
      await ensureCommandAvailable(
        "python3",
        ["--version"],
        'python3 is required to run Python automations locally. Install Python 3 and make sure "python3" is on your PATH.',
      );
      return {
        args: [scriptPath],
        command: "python3",
        displayName: "python3",
      };
    case ".ts":
      // Node strips the types; the run image runs TypeScript the same way.
      if (!process.features.typescript) {
        throw new AutomationRuntimeError(
          "INTERPRETER_NOT_FOUND",
          `Node ${process.version} cannot run TypeScript. Swizzle runs .ts entrypoints with Node's type stripping, which needs Node 22.18 or later.`,
        );
      }
      return {
        args: [scriptPath],
        command: process.execPath,
        displayName: path.basename(process.execPath),
      };
    case ".js":
      return {
        args: [scriptPath],
        command: process.execPath,
        displayName: path.basename(process.execPath),
      };
  }
}

async function ensureCommandAvailable(
  command: string,
  args: string[],
  errorMessage: string,
): Promise<void> {
  const outcome = await new Promise<{ exitCode: number | null; failedToSpawn: boolean }>(
    (resolvePromise) => {
      const child = spawn(command, args, { stdio: "ignore" });

      child.once("error", () => {
        resolvePromise({ exitCode: null, failedToSpawn: true });
      });

      child.once("close", (exitCode) => {
        resolvePromise({ exitCode, failedToSpawn: false });
      });
    },
  );

  if (outcome.failedToSpawn || outcome.exitCode !== 0) {
    throw new AutomationRuntimeError("INTERPRETER_NOT_FOUND", errorMessage);
  }
}

async function executeChildProcess(input: {
  readonly abortSignal?: AbortSignal;
  readonly command: ExecutionCommand;
  readonly definition: AutomationDefinition;
  readonly environment: NodeJS.ProcessEnv;
  readonly onStderrChunk?: (chunk: string) => void | Promise<void>;
  readonly onStdoutChunk?: (chunk: string) => void | Promise<void>;
  readonly outputLimitBytes: number;
  readonly payload: unknown;
  readonly scratchDirectory: string;
  readonly timeoutMs: number;
}): Promise<ExecutionOutcome> {
  const spawnOptions: SpawnOptionsWithoutStdio = {
    cwd: input.scratchDirectory,
    env: input.environment,
    stdio: "pipe",
  };

  return await new Promise<ExecutionOutcome>((resolvePromise, rejectPromise) => {
    if (input.abortSignal?.aborted)
      throw new AutomationRuntimeError("RUN_CANCELLED", "Run cancelled by user.");
    const child = spawn(input.command.command, input.command.args, spawnOptions);

    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let abortListener: (() => void) | undefined;

    const detachAbortListener = () => {
      if (abortListener && input.abortSignal) {
        input.abortSignal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };

    const settleWithFailure = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      detachAbortListener();
      rejectPromise(error);
    };

    const settleWithSuccess = (outcome: ExecutionOutcome) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      detachAbortListener();
      resolvePromise(outcome);
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, DEFAULT_KILL_GRACE_PERIOD_MS);
    }, input.timeoutMs);

    if (input.abortSignal) {
      const onAbort = () => {
        if (aborted || settled) return;
        aborted = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, DEFAULT_ABORT_KILL_GRACE_PERIOD_MS);
      };
      abortListener = onAbort;
      if (input.abortSignal.aborted) {
        onAbort();
      } else {
        input.abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const stopForOutputLimit = () => {
      if (settled) {
        return;
      }

      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, DEFAULT_KILL_GRACE_PERIOD_MS);
    };

    const output = new OutputPump({
      stdout: child.stdout,
      stderr: child.stderr,
      stdoutLimitBytes: input.outputLimitBytes,
      stderrLimitBytes: input.outputLimitBytes,
      onStdoutChunk: input.onStdoutChunk,
      onStderrChunk: input.onStderrChunk,
      limitPolicy: "stop",
      onStop: (reason) => {
        if (reason.kind === "limit") stopForOutputLimit();
        else child.kill("SIGTERM");
      },
    });

    child.once("error", (error) => {
      settleWithFailure(
        new AutomationRuntimeError(
          "INTERPRETER_NOT_FOUND",
          `Could not start ${input.command.displayName}: ${getErrorMessage(error)}`,
          { cause: error },
        ),
      );
    });

    child.once("close", (exitCode, signal) => {
      void output.finished().then(() => {
        settleWithSuccess({
          aborted,
          exitCode,
          outputLimitBytes: input.outputLimitBytes,
          outputLimitExceeded: output.exceeded,
          signal,
          stderr: output.stderr,
          stdout: output.stdout,
          timedOut,
        });
      }, settleWithFailure);
    });

    child.stdin.on("error", (error) => {
      const maybeNodeError = error as NodeJS.ErrnoException;
      if (maybeNodeError.code === "EPIPE") {
        return;
      }

      settleWithFailure(error);
    });

    child.stdin.end(JSON.stringify(input.payload));
  });
}

function normalizeOutputLimitBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CHILD_OUTPUT_LIMIT_BYTES;
  }

  return Math.max(1, Math.floor(value));
}

/**
 * Whether a run executes in a sandbox container: when the automation asks for one, and for every
 * platform run of a worker that requires the sandbox.
 */
export function runsInSandbox(definition: AutomationDefinition, platformRun: boolean): boolean {
  if (definition.config.runtime.execution_mode === "container") return true;
  if (!platformRun) return false;
  return process.env.SWIZZLE_REQUIRE_SANDBOX?.trim().toLowerCase() === "true";
}

function selectContainerAutomationEnvironment(
  secrets: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const secretName of secrets) {
    const value = environment[secretName];
    if (value !== undefined) selected[secretName] = value;
  }
  for (const [key, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      (key === SWIZZLE_LINK_KEY_ENV ||
        key === SWIZZLE_LINK_URL_ENV ||
        key.startsWith("SWIZZLE_CONNECTION_"))
    ) {
      selected[key] = value;
    }
  }
  return selected;
}

function compactEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function toRuntimeSegment(value: string): string {
  return createDisplayName(value)
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .toLowerCase();
}
