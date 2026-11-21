import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateWebhookPayloadAgainstSchema } from "@swizzle/config";
import { createDisplayName } from "@swizzle/core";
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
import {
  type ExecutionOutcome,
  executeProcess,
  parseProcessResult,
  requireProcessExit,
} from "./process-execution.js";
import type { AutomationRunFailure, AutomationRunResult, RuntimeMetadata } from "./run-result.js";
import { buildRuntimeEnvironmentAdditions } from "./runtime-requirements.js";
import { assertRuntimeTimeoutWithinPlatformCeiling } from "./timeout-policy.js";
import { type AutomationDefinition, loadAutomationDefinition } from "./validation.js";
import { SWIZZLE_LINK_KEY_ENV, SWIZZLE_LINK_URL_ENV } from "./wait-links.js";
import { materializeWebhookRunContext } from "./webhook-context.js";

const DEFAULT_CHILD_OUTPUT_LIMIT_BYTES = 1_048_576;

export interface ExecutionOptions {
  readonly abortSignal?: AbortSignal;
  readonly attempt?: number;
  readonly automationDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly environmentName: string;
  readonly executionNumber?: number;
  readonly grantMaxTimeoutMs?: number | null;
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

export async function runAutomation(options: RunAutomationOptions): Promise<AutomationRunResult> {
  return await execute(options, (definition) => entrypointScript(definition, options));
}

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
    const definition = await loadAutomationDefinition(
      options.automationDirectory,
      options.runtimeMetadata === undefined ? "source" : "deployment",
    );
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

    const outputLimitBytes = normalizeOutputLimitBytes(options.outputLimitBytes);
    const execution = await Promise.resolve()
      .then(async () => {
        await options.onReady?.();
        return requireProcessExit(
          await executeChildProcess({
            abortSignal: options.abortSignal,
            command: executionCommand,
            environment: runtimeEnvironment,
            onStderrChunk: options.onStderrChunk,
            onStdoutChunk: options.onStdoutChunk,
            outputLimitBytes,
            payload,
            scratchDirectory,
            timeoutMs: timeoutPolicy.timeoutMs,
          }),
        );
      })
      .finally(async () => {
        await Promise.all([
          webhookRuntime?.cleanup(),
          rm(scratchDirectory, { force: true, recursive: true }),
        ]);
      });

    return {
      ...parseProcessResult({
        durationMs: Date.now() - startedAt,
        execution,
        messages: {
          timeout: `Automation exceeded timeout ${definition.config.runtime.timeout}.`,
          signalPrefix: "Automation terminated by signal",
          exitSubject: "Automation",
          emptyStdout:
            "Automation exited successfully but stdout was empty. Successful runs must print JSON to stdout.",
          invalidStdoutPrefix: "Automation exited successfully but stdout was not valid JSON",
        },
        outputLimitBytes,
        payload,
        runId,
      }),
      stderr: dependencyStderr + execution.stderr,
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

export async function executeChildProcess(input: {
  readonly abortSignal?: AbortSignal | undefined;
  readonly command: ExecutionCommand;
  readonly environment: NodeJS.ProcessEnv;
  readonly onStderrChunk?: ((chunk: string) => void | Promise<void>) | undefined;
  readonly onStdoutChunk?: ((chunk: string) => void | Promise<void>) | undefined;
  readonly outputLimitBytes: number;
  readonly payload: unknown;
  readonly scratchDirectory: string;
  readonly timeoutMs: number;
}): Promise<ExecutionOutcome> {
  return await executeProcess({
    abortSignal: input.abortSignal,
    onStderrChunk: input.onStderrChunk,
    onStdoutChunk: input.onStdoutChunk,
    outputLimitBytes: input.outputLimitBytes,
    timeoutMs: input.timeoutMs,
    start: () =>
      spawn(input.command.command, input.command.args, {
        cwd: input.scratchDirectory,
        env: input.environment,
        stdio: "pipe",
      }),
    startError: (error) =>
      new AutomationRuntimeError(
        "INTERPRETER_NOT_FOUND",
        `Could not start ${input.command.displayName}: ${getErrorMessage(error)}`,
        { cause: error },
      ),
    sendInput: (stdin) => stdin.end(JSON.stringify(input.payload)),
    termination: {
      kind: "host",
      exitGraceMs: 1_000,
      signals: {
        graceful: "SIGTERM",
        force: "SIGKILL",
        abortGraceMs: 5_000,
      },
    },
  });
}

function normalizeOutputLimitBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CHILD_OUTPUT_LIMIT_BYTES;
  }

  return Math.max(1, Math.floor(value));
}

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
