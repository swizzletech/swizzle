import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { extractFlowNodeIds, flowDrift, scanStepSites, stepSourceLanguage } from "@swizzle/config";
import {
  type AutomationDefinition,
  type AutomationRunFailure,
  AutomationRuntimeError,
  bundleEntrypointDryRun,
  checkOutcome,
  evaluateLocalAutomationReadiness,
  findSamplePayloadFile,
  getDeclaredDependencyManifestPaths,
  loadAutomationDefinition,
  runAutomation,
  runAutomationCheck,
} from "@swizzle/runtime";
import type { DeploymentCheckResponse } from "@swizzle/runtime/http-contract";
import { type Command, Option } from "commander";
import { packAutomationOrThrow, postDeploymentCheck } from "./automation-api.js";
import {
  formatApiCheckSummary,
  formatList,
  formatTriggerSummary,
  readinessFields,
  writeStderrLogs,
} from "./automation-output.js";
import {
  type ApiCommandOptions,
  localCommand,
  type RunHandler,
  withExamples,
} from "./command-support.js";
import { deploymentCheckOutput } from "./deployment-output.js";
import { buildEnvironmentNotPinnedError } from "./environment-guard.js";
import { mapRuntimeErrorToAgentError } from "./errors.js";
import { createAutomationScaffold } from "./init.js";
import { AgentError, type CliIO, EXIT_CODES, respond, warn } from "./output.js";
import { loadProfileConfig, resolveEnvironment, resolveProfile } from "./profile.js";
import {
  getSerializableScaffoldCatalog,
  INIT_TEMPLATE_IDS,
  type InitTemplateId,
  SCAFFOLD_PATTERN_IDS,
  type ScaffoldPatternId,
  signingKeyCommands,
} from "./scaffolds.js";

const execFileAsync = promisify(execFile);

export function registerLocalCommands(program: Command, io: CliIO, runHandler: RunHandler): void {
  registerInit(program, io, runHandler);
  registerScaffolds(program, io);
  registerValidate(program, io, runHandler);
  registerRun(program, io, runHandler);
}

function registerInit(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = localCommand(
    program
      .command("init")
      .description("Scaffold a new automation folder")
      .argument("<targetDir>", "Directory to create")
      .addOption(
        new Option("-t, --template <name>", "Language template (default: the pattern's)").choices(
          INIT_TEMPLATE_IDS,
        ),
      )
      .addOption(
        new Option("-p, --pattern <name>", "Scaffold pattern (default: webhook-basic)").choices(
          SCAFFOLD_PATTERN_IDS,
        ),
      ),
  );
  withExamples(command, [
    "swizzle init ./hello-webhook",
    "swizzle init ./nightly-index --pattern cron-indexer --template typescript",
  ]);
  command.action(
    async (
      targetDir: string,
      options: { readonly pattern?: ScaffoldPatternId; readonly template?: InitTemplateId },
    ) => {
      await runHandler(async () => {
        const scaffold = await createAutomationScaffold({
          ...(options.pattern !== undefined ? { pattern: options.pattern } : {}),
          targetDirectory: targetDir,
          ...(options.template !== undefined ? { template: options.template } : {}),
        });
        const { trigger } = scaffold;
        respond(
          io,
          {
            automation: {
              name: scaffold.automationName,
              template: scaffold.template,
              pattern: scaffold.pattern,
              directory: scaffold.absoluteTargetDirectory,
              samplePayload: displayPath(scaffold.samplePayloadPath),
              files: scaffold.createdFiles,
            },
            ...(trigger.type === "webhook"
              ? {
                  webhook: `${trigger.path}, a secret URL; a deployed run starts only for a request signed with the secret ${trigger.signature.secret} (README.md shows how)`,
                }
              : {}),
            apiCheck: `none yet. Once the automation uses a secret or a connection, set api_check in config.yaml: active runs ${scaffold.checkFile} (a stub to replace with a read-only check), passive adds no calls, off needs a reason.`,
          },
          [
            `Run \`swizzle run ${targetDir}\` to run it locally with its sample payload`,
            ...(trigger.type === "webhook"
              ? [
                  `Run ${signingKeyCommands(trigger.signature.secret)
                    .map((command) => `\`${command}\``)
                    .join(" and ")} to store the signing key, and give the sender the same key`,
                ]
              : []),
            `Run \`swizzle validate ${targetDir}\` to check it against the workers that would run it`,
            `Run \`swizzle apply ${targetDir}\` to deploy it`,
          ],
        );
      });
    },
  );
}

function registerScaffolds(program: Command, io: CliIO): void {
  const command = localCommand(
    program
      .command("scaffolds")
      .description("List the templates and patterns `swizzle init` scaffolds from"),
  );
  withExamples(command, ["swizzle scaffolds", "swizzle scaffolds --json"]);
  command.action(() => {
    const catalog = getSerializableScaffoldCatalog();
    respond(
      io,
      {
        templates: catalog.templates.map((template) => ({
          id: template.id,
          runtime: template.runtime,
          useCases: template.useCases.join("; "),
        })),
        patterns: catalog.patterns.map((pattern) => ({
          id: pattern.id,
          template: pattern.recommendedTemplateId,
          templates: pattern.supportedTemplateIds.join(" "),
          description: pattern.description,
        })),
      },
      ["Run `swizzle init <dir> --pattern <id> --template <id>` to scaffold one"],
    );
  });
}

function registerValidate(program: Command, io: CliIO, runHandler: RunHandler): void {
  // Local: it resolves the profile itself, and checks readiness locally when none is configured.
  const command = localCommand(
    program
      .command("validate")
      .description(
        "Check an automation folder: config, syntax, declared env, flow, and whether a worker can run it",
      )
      .argument("[automationDir]", "Path to an automation directory (default: .)")
      .option(
        "--bundle",
        "Dry-run bundle/transform validation for Node.js, TypeScript, or Python entrypoints",
      )
      .option(
        "--project <project>",
        "Project a new automation would join, by slug or id (default: the profile's, else the default project); an existing one stays in its own, and naming another is refused as apply refuses it",
      ),
  );
  withExamples(command, [
    "swizzle validate ./hello-webhook",
    "swizzle validate ./hello-webhook --bundle --profile prod -e production",
  ]);
  command.action(
    async (
      automationDir: string | undefined,
      options: ApiCommandOptions & { readonly bundle?: boolean; readonly project?: string },
    ) => {
      const dir = automationDir ?? ".";
      await runHandler(async () => {
        const definition = await loadAutomationDefinition(dir);
        const samplePayloadPath = await findSamplePayloadFile(definition.directory);
        const syntax = await runSyntaxValidation(definition);
        const env = await runEnvReferenceValidation(definition);
        await runFlowDriftValidation(definition);
        const readinessResult = await resolveValidationReadiness(definition, options);
        for (const warning of readinessResult.warnings) warn(warning);
        const bundle = options.bundle ? await runBundleValidation(definition) : undefined;
        const readiness = readinessResult.readiness;
        const config = definition.config;
        const shownDirectory = displayPath(definition.directory);
        respond(
          io,
          {
            valid: true,
            automation: {
              name: config.name,
              version: config.version,
              entrypoint: definition.entrypointRelativePath,
              trigger: formatTriggerSummary(config.trigger),
              runtime: `${config.runtime.language} / sandbox (container) / ${config.runtime.profile}`,
              localRun: config.runtime.execution_mode,
              requirements: formatList(getDeclaredDependencyManifestPaths(definition)),
              secrets: formatList(config.secrets),
              vars: formatVars(config.vars),
              apiCheck: formatApiCheckSummary(config.api_check),
              samplePayload: samplePayloadPath
                ? path.relative(definition.directory, samplePayloadPath)
                : "none",
            },
            ...(readinessResult.source === "local"
              ? {}
              : {
                  deployment: deploymentCheckOutput(readinessResult.deployment),
                }),
            checks: {
              ...(syntax !== undefined ? { syntax: `ok (${syntax.mode})` } : {}),
              ...(bundle !== undefined ? { bundle: `ok (${bundle.mode})` } : {}),
              ...readinessFields(
                readiness,
                readinessResult.source === "remote" ? "the target's workers" : "this machine",
              ),
              undeclaredEnv: formatList(env.undeclared),
            },
          },
          [
            `Run \`swizzle run ${shownDirectory}\` to run it locally`,
            ...(config.api_check?.mode === "active"
              ? [`Run \`swizzle run --check ${shownDirectory}\` to run its API check`]
              : []),
            `Run \`swizzle apply ${shownDirectory} --dry-run\` to see what a deploy changes`,
          ],
        );
      });
    },
  );
}

function registerRun(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = localCommand(
    program
      .command("run")
      .description(
        "Run an automation folder once on this machine, as a host process without the sandbox: run only code you trust. Its logs go to stderr",
      )
      .argument("[automationDir]", "Path to an automation directory (default: .)")
      .option("-p, --payload <json>", "Inline JSON payload")
      .option("-f, --payload-file <path>", "Path to a JSON payload file")
      .option(
        "--check",
        "Run the API check script (api_check.mode active) instead of the entrypoint: payload {}, no state",
      ),
  );
  withExamples(command, [
    "swizzle run ./hello-webhook",
    'swizzle run ./hello-webhook --payload \'{"name":"Ada"}\'',
    "swizzle run --check ./invoice-sync",
  ]);
  command.action(
    async (
      automationDir: string | undefined,
      options: {
        readonly check?: boolean;
        readonly payload?: string;
        readonly payloadFile?: string;
      },
    ) => {
      const dir = automationDir ?? ".";
      await runHandler(async () => {
        if (options.check === true) {
          await runApiCheck(dir, io, options);
          return;
        }
        if (options.payload !== undefined && options.payloadFile !== undefined) {
          throw new AgentError({
            code: "PAYLOAD_OPTIONS_CONFLICT",
            exitCode: EXIT_CODES.usage,
            hint: "Pass either --payload or --payload-file, not both.",
            message: "--payload and --payload-file were both given.",
          });
        }
        const payloadInput = await resolveRunPayloadInput(dir, options);
        const result = await runAutomation({
          automationDirectory: dir,
          environmentName: "local",
          ...(payloadInput.filePath !== undefined ? { filePath: payloadInput.filePath } : {}),
          ...(payloadInput.inlineJson !== undefined ? { inlineJson: payloadInput.inlineJson } : {}),
        });
        writeStderrLogs(io, result.stderr);
        if (!result.success) throw buildRunFailureError(result);
        respond(
          io,
          {
            run: {
              status: "succeeded",
              durationMs: result.durationMs,
              payload: payloadInput.label,
            },
            result: result.result,
          },
          [`Run \`swizzle apply ${dir}\` to deploy it`],
        );
      });
    },
  );
}

/**
 * `swizzle run --check`: the check script as a local host process, read by the check contract
 * (green, explicit drift, or an error such as an exception or failed login).
 */
async function runApiCheck(
  dir: string,
  io: CliIO,
  options: { readonly payload?: string; readonly payloadFile?: string },
): Promise<void> {
  if (options.payload !== undefined || options.payloadFile !== undefined) {
    throw new AgentError({
      code: "PAYLOAD_OPTIONS_CONFLICT",
      exitCode: EXIT_CODES.usage,
      hint: "Drop --payload and --payload-file: a check always reads the payload {}.",
      message: "--check runs the API check, which takes no payload.",
    });
  }
  const { config } = await loadAutomationDefinition(dir);
  if (config.api_check?.mode !== "active") {
    throw new AgentError({
      code: "API_CHECK_NOT_ACTIVE",
      exitCode: EXIT_CODES.validation,
      hint: "Set `api_check: { mode: active }` in config.yaml. `swizzle init` scaffolds a check stub beside the entrypoint.",
      message: `${config.name} has no active API check: api_check.mode is ${config.api_check?.mode ?? "not set"}.`,
    });
  }
  const result = await runAutomationCheck({ automationDirectory: dir, environmentName: "local" });
  writeStderrLogs(io, result.stderr);
  const outcome = checkOutcome(result);
  if (outcome.status === "drift") {
    throw new AgentError({
      code: "API_CHECK_DRIFT",
      details: { exitCode: 1, output: outcome.output },
      hint: "The check reached the API and the answer differs from what the code expects. Update the response parsing the entrypoint and the check share, then redeploy with `swizzle apply .`.",
      message: `The API check found drift: ${outcome.output ?? "(no stdout)"}`,
    });
  }
  if (outcome.status === "error") {
    if (outcome.failure !== "credentials" && !result.success) {
      const mapped = buildRunFailureError(result);
      throw new AgentError({
        code: mapped.code,
        details: { ...mapped.details, output: outcome.output },
        hint: mapped.hint ?? "The check's log is above on stderr.",
        message: `The API check failed: ${outcome.message}`,
        retryable: mapped.retryable,
        exitCode: mapped.exitCode,
      });
    }
    throw new AgentError({
      code: outcome.failure === "credentials" ? "API_CHECK_CREDENTIALS" : "API_CHECK_ERROR",
      details: { exitCode: outcome.exitCode, output: outcome.output },
      hint:
        outcome.failure === "credentials"
          ? "Fix the check's credentials or connection, then rerun `swizzle run --check .`."
          : 'Print a JSON object with "ok": true when the check passes. Signal drift with contract_changed or a bare exit 1.',
      message: `The API check failed: ${outcome.message}`,
    });
  }
  // Green implies success; the stored output is bounded, so print the whole answer instead.
  respond(io, {
    check: { status: "green", durationMs: result.durationMs },
    result: result.success ? result.result : null,
  });
}

function buildRunFailureError(result: AutomationRunFailure): AgentError {
  const base = new AutomationRuntimeError(result.code, result.message);
  const mapped = mapRuntimeErrorToAgentError(base);
  return new AgentError({
    code: mapped.code,
    details: {
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(result.stderr.length > 0 ? { stderrTail: result.stderr.slice(-1024) } : {}),
    },
    hint: mapped.hint ?? "The run's log is above on stderr.",
    message: result.message,
    retryable: mapped.retryable,
  });
}

function formatVars(vars: Record<string, string | number | boolean>): string {
  const entries = Object.entries(vars).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0
    ? "none"
    : entries.map(([name, value]) => `${name}=${String(value)}`).join(", ");
}

async function runSyntaxValidation(
  definition: AutomationDefinition,
): Promise<SyntaxValidationSummary | undefined> {
  if (definition.config.runtime.language !== "python") {
    return undefined;
  }

  const validation = await runPythonSyntaxValidation(definition.entrypointPath);
  if (validation.warning) {
    warn(validation.warning);
  }
  return validation;
}

async function runEnvReferenceValidation(
  definition: AutomationDefinition,
): Promise<EnvReferenceValidationSummary> {
  const source = await readFile(definition.entrypointPath, "utf8");
  const referenced = findLiteralEnvReferences(source, definition.config.runtime.language);
  const declared = new Set([...definition.config.secrets, ...Object.keys(definition.config.vars)]);
  const undeclared = referenced.filter(
    (name) => !declared.has(name) && !name.startsWith("SWIZZLE_"),
  );

  if (undeclared.length > 0) {
    warn(
      `env vars ${undeclared.join(", ")} are referenced but undeclared: a run sees only declared secrets and vars, so they are unset at runtime`,
    );
  }

  return {
    referenced,
    undeclared,
  };
}

/**
 * Warns where flow.mermaid and the entrypoint disagree on step names, so the dashboard's track can
 * light every station. Drift never fails validation: the flow is documentation.
 */
async function runFlowDriftValidation(definition: AutomationDefinition): Promise<void> {
  const mermaid = await readFile(path.join(definition.directory, "flow.mermaid"), "utf8").catch(
    () => null,
  );
  if (mermaid === null) return;
  const source = await readFile(definition.entrypointPath, "utf8");
  const sites = scanStepSites(stepSourceLanguage(definition.config.runtime.language), source);
  for (const warning of flowDrift(extractFlowNodeIds(mermaid), sites)) {
    warn(warning.message);
  }
}

function findLiteralEnvReferences(
  source: string,
  language: AutomationDefinition["config"]["runtime"]["language"],
): readonly string[] {
  const references = new Set<string>();
  const patterns =
    language === "python"
      ? [
          /\bos\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']\s*(?=[,)])/g,
          /\bos\.environ\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
          /\bos\.environ\.get\(\s*["']([A-Z][A-Z0-9_]*)["']\s*(?=[,)])/g,
        ]
      : [
          /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
          /\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
        ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) {
        references.add(name);
      }
    }
  }

  return [...references].sort((left, right) => left.localeCompare(right));
}

async function resolveValidationReadiness(
  definition: AutomationDefinition,
  options: ApiCommandOptions & { readonly project?: string },
): Promise<
  | {
      readonly source: "local";
      readonly readiness: Awaited<ReturnType<typeof evaluateLocalAutomationReadiness>>;
      readonly warnings: readonly string[];
    }
  | {
      readonly source: "remote";
      readonly readiness: DeploymentCheckResponse["readiness"];
      readonly deployment: DeploymentCheckResponse;
      readonly warnings: readonly string[];
    }
> {
  const config = await loadProfileConfig();
  const hasExplicitApiUrl = options.apiUrl !== undefined;
  const hasExplicitProfile = options.profile !== undefined;
  const usesRemote =
    hasExplicitProfile ||
    hasExplicitApiUrl ||
    (process.env.SWIZZLE_PROFILE ?? "").trim().length > 0 ||
    config.defaultProfile !== undefined;

  if (!usesRemote) {
    return {
      readiness: await evaluateLocalAutomationReadiness(definition),
      source: "local",
      warnings: [],
    };
  }

  const resolvedProfile = resolveProfile({
    config,
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
  });
  const resolvedEnvironment = resolveEnvironment({
    ...(options.environment !== undefined ? { flag: options.environment } : {}),
    profileEnvironment: resolvedProfile.environment,
    profileName: resolvedProfile.name,
  });
  if (resolvedEnvironment.source === "unpinned") {
    throw await buildEnvironmentNotPinnedError({
      options: { apiUrl: resolvedProfile.url },
      profileName: resolvedProfile.name,
    });
  }

  // validate resolves its profile here, so the profile's project fills --project as it does for apply.
  let check: DeploymentCheckResponse;
  try {
    check = await postDeploymentCheck(await packAutomationOrThrow(definition.directory), {
      apiUrl: resolvedProfile.url,
      environment: resolvedEnvironment.environment,
      project: options.project ?? resolvedProfile.project ?? undefined,
      token: resolvedProfile.token,
    });
  } catch (error) {
    if (
      resolvedProfile.source === "default" &&
      !hasExplicitApiUrl &&
      !hasExplicitProfile &&
      isDegradableReadinessApiError(error)
    ) {
      return {
        readiness: await evaluateLocalAutomationReadiness(definition),
        source: "local",
        warnings: [
          `API at ${resolvedProfile.url} unreachable, so readiness was checked on this machine; pass --profile to validate against a live instance`,
        ],
      };
    }
    throw error;
  }
  return { deployment: check, readiness: check.readiness, source: "remote", warnings: [] };
}

function isDegradableReadinessApiError(error: unknown): boolean {
  if (!(error instanceof AgentError)) {
    return false;
  }
  if (error.code === "API_UNREACHABLE" || error.code === "API_TIMEOUT") {
    return true;
  }
  const httpStatus = error.details?.httpStatus;
  if (typeof httpStatus === "number" && httpStatus >= 500 && httpStatus < 600) {
    return true;
  }
  return /^HTTP_5\d\d$/.test(error.code);
}

async function runBundleValidation(
  definition: AutomationDefinition,
): Promise<BundleValidationSummary> {
  if (definition.config.runtime.language === "python") {
    return await runPythonBundleValidation(definition.entrypointPath);
  }

  if (
    definition.config.runtime.language !== "node" &&
    definition.config.runtime.language !== "typescript"
  ) {
    throw new AgentError({
      code: "VALIDATE_BUNDLE_UNSUPPORTED_LANGUAGE",
      hint: "Use --bundle with Node.js, TypeScript, or Python automations.",
      message: `Bundle dry-run is not supported for language: ${definition.config.runtime.language}`,
      retryable: false,
    });
  }

  const outputFormat = await resolveBundleOutputFormat(definition.directory);
  const dryRun = await bundleEntrypointDryRun({
    language: definition.config.runtime.language,
    outputFormat,
    path: definition.entrypointPath,
  });

  if (!dryRun.ok) {
    throw new AgentError({
      code: "VALIDATE_BUNDLE_FAILED",
      exitCode: EXIT_CODES.validation,
      ...(dryRun.errors.length > 1 ? { details: { errors: dryRun.errors } } : {}),
      hint: "Fix the entrypoint until `swizzle validate --bundle` passes.",
      message: dryRun.errors.join("\n"),
    });
  }

  return {
    mode: outputFormat,
    ok: true,
  };
}

// The module format Node runs the entrypoint in: CommonJS only when package.json says so. Without
// a "type", Node runs a file that uses import, export or top-level await as an ES module, and
// esbuild accepts a CommonJS file in ESM output, so the check assumes ESM.
async function resolveBundleOutputFormat(directory: string): Promise<"cjs" | "esm"> {
  const packageJsonPath = path.join(directory, "package.json");

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { readonly type?: string };
    return parsed.type === "commonjs" ? "cjs" : "esm";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "esm";
    }

    throw new AgentError({
      code: "PACKAGE_JSON_INVALID",
      hint: "Fix package.json JSON syntax or remove the file if the automation does not use it.",
      message: `Could not parse ${packageJsonPath}: ${(error as Error).message}`,
      retryable: false,
    });
  }
}

// Prints `line:column: message` to stderr for a syntax error, so no traceback reaches the caller.
const PYTHON_SYNTAX_CHECK = [
  "import sys",
  "try: compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')",
  "except SyntaxError as e: sys.exit(f'{e.lineno}:{e.offset}: {e.msg}')",
].join("\n");

async function runPythonSyntaxValidation(entrypointPath: string): Promise<SyntaxValidationSummary> {
  try {
    // Compile the raw bytes in memory, so Python applies its own BOM and `# coding:` handling: `-m py_compile` would write __pycache__ into the author's folder.
    await execFileAsync("python3", ["-c", PYTHON_SYNTAX_CHECK, entrypointPath]);
    return {
      mode: "compile",
      ok: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        mode: "compile",
        ok: true,
        warning: "python3 is not available on PATH, so syntax validation was skipped.",
      };
    }

    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new AgentError({
      code: "PYTHON_SYNTAX_INVALID",
      exitCode: EXIT_CODES.validation,
      hint: "Fix the Python syntax error, then rerun `swizzle validate`.",
      message: `${displayPath(entrypointPath)}:${stderr || " Python could not compile it"}`,
    });
  }
}

async function runPythonBundleValidation(entrypointPath: string): Promise<BundleValidationSummary> {
  return await runPythonSyntaxValidation(entrypointPath);
}

async function resolveRunPayloadInput(
  automationDir: string,
  options: { readonly payload?: string; readonly payloadFile?: string },
): Promise<ResolvedRunPayloadInput> {
  if (options.payload !== undefined) return { inlineJson: options.payload, label: "inline" };
  if (options.payloadFile !== undefined) {
    return { filePath: options.payloadFile, label: options.payloadFile };
  }
  const samplePayloadPath = await findSamplePayloadFile(automationDir);
  if (samplePayloadPath) {
    return {
      filePath: samplePayloadPath,
      label: `${displayPath(samplePayloadPath)} (sample)`,
    };
  }
  return { label: "{} (none given)" };
}

/** Where the payload came from, as `run.payload` reports it. */
interface ResolvedRunPayloadInput {
  readonly filePath?: string;
  readonly inlineJson?: string;
  readonly label: string;
}

interface SyntaxValidationSummary {
  readonly mode: "cjs" | "esm" | "compile";
  readonly ok: true;
  readonly warning?: string;
}

interface BundleValidationSummary extends SyntaxValidationSummary {}

interface EnvReferenceValidationSummary {
  readonly referenced: readonly string[];
  readonly undeclared: readonly string[];
}

/** A path as a command names it: relative inside the working directory, absolute outside it. */
function displayPath(target: string): string {
  const relative = path.relative(process.cwd(), target);
  if (relative === "") return ".";
  const outside =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return outside ? target : relative;
}
