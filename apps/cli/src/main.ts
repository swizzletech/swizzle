/**
 * The `swizzle` command tree and its one runner. `createProgram` registers every command group;
 * `runCli` parses argv, prints every answer and every error through output.ts, and returns the
 * exit code. bin.ts is the executable that calls `runNodeCli`.
 */
import {
  AUTOMATION_RUNTIME_EXECUTION_MODES,
  AUTOMATION_RUNTIME_LANGUAGES,
  AUTOMATION_TRIGGER_TYPES,
  createAutomationConfigJsonSchema,
} from "@swizzle/config";
import { RUN_STATUSES } from "@swizzle/db";
import { Command, CommanderError } from "commander";
import { registerAccessCommands } from "./access-commands.js";
import { registerAdminCommands } from "./admin-commands.js";
import { resetApiAmbientContext, setApiAmbientContext } from "./api.js";
import { registerAutomationCommands } from "./automation-commands.js";
import { registerBackup } from "./backup.js";
import {
  type ApiCommandOptions,
  isLocalCommand,
  localCommand,
  withExamples,
} from "./command-support.js";
import { registerConnectionCommands } from "./connection-commands.js";
import { registerCredentialCommands } from "./credential-commands.js";
import { registerDeploymentCommands } from "./deployment-commands.js";
import { toAgentError } from "./errors.js";
import { DESCRIPTION, renderHome } from "./home.js";
import { registerHooksCommand } from "./hooks-command.js";
import { checkInvocation, commandPath, describeCommandTree } from "./introspect.js";
import { registerLocalCommands } from "./local-commands.js";
import {
  AgentError,
  type CliIO,
  EXIT_CODES,
  HandledCliError,
  respond,
  respondError,
  setOutputFormat,
} from "./output.js";
import { loadProfileConfig, resolveProfile } from "./profile.js";
import { registerProfile } from "./profile-command.js";
import { registerRunCommands } from "./run-commands.js";
import { getSerializableScaffoldCatalog } from "./scaffolds.js";
import { registerSecurityCommand } from "./security-command.js";
import { registerSkillCommand } from "./skill-command.js";
import { VERSION } from "./version.js";
import { registerWorkerCommands } from "./worker-commands.js";
import { registerWorkspaceCommand } from "./workspace-command.js";

export { checkInvocation, describeCommandTree, describeOption } from "./introspect.js";

/** The flags every command accepts, wherever they stand in argv. */
const GLOBAL_OPTIONS = ["apiUrl", "profile", "environment", "debug"] as const;

export function createProgram(io: CliIO = createNodeIO()): Command {
  const program = new Command();

  program.name("swizzle").description(DESCRIPTION).version(VERSION, "-V, --version");
  program.exitOverride();
  program.showHelpAfterError(false);
  program.configureHelp({ showGlobalOptions: true });
  program.option("--api-url <url>", "Swizzle API base URL (default: the profile's)");
  program.option("--profile <name>", "CLI profile from ~/.swizzle/config.toml");
  program.option("-e, --environment <name>", "Environment (default: the profile's)");
  program.option("--json", "Print JSON instead of TOON");
  program.option("--debug", "Log API requests to stderr, tokens redacted");
  program.configureOutput({
    outputError: () => undefined,
    writeErr: (message) => io.stderr(message),
    writeOut: (message) => io.stdout(message),
  });
  program.action(async () => await renderHome(io, program.opts() as ApiCommandOptions));
  // The loop an agent runs, so `swizzle --help` alone is enough to build, ship and operate one.
  withExamples(program, [
    "swizzle init ./hello -t python",
    `swizzle run ./hello --payload '{"name":"Ada"}'`,
    "swizzle apply ./hello -e prod",
    `swizzle trigger hello -p '{"name":"Ada"}' -e prod`,
    "swizzle logs hello --follow -e prod",
    "swizzle approvals -e prod",
    "swizzle diagnose <run-id>",
  ]);

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    const globals = program.opts() as ApiCommandOptions;
    for (const name of GLOBAL_OPTIONS) {
      if (globals[name] !== undefined) actionCommand.setOptionValue(name, globals[name]);
    }
    resetApiAmbientContext();
    const debugLogger = (message: string) => io.stderr(`${message}\n`);
    if (
      isLocalCommand(actionCommand) ||
      actionCommand === program ||
      actionCommand.getOptionValue("localOnly") === true
    ) {
      setApiAmbientContext({ debug: globals.debug === true, debugLogger, token: null });
      return;
    }

    const resolved = resolveProfile({
      ...(globals.profile !== undefined ? { profile: globals.profile } : {}),
      ...(globals.apiUrl !== undefined ? { apiUrl: globals.apiUrl } : {}),
      config: await loadProfileConfig(),
    });
    actionCommand.setOptionValue("apiUrl", resolved.url);
    // The profile's project fills every optional --project the command was not given. A required
    // one, such as move's target, stays explicit: commander checks it before this hook runs.
    const definesProject = actionCommand.options.some(
      (option) => option.long === "--project" && !option.mandatory,
    );
    if (
      definesProject &&
      resolved.project !== null &&
      actionCommand.getOptionValue("project") === undefined
    ) {
      actionCommand.setOptionValueWithSource("project", resolved.project, "config");
    }
    // Command actions use this token for environment discovery and their API calls.
    setApiAmbientContext({ debug: globals.debug === true, debugLogger, token: resolved.token });
  });

  program.commandsGroup("Build and run locally:");
  registerLocalCommands(program, io, runHandler(io));
  program.commandsGroup("Deploy:");
  registerDeploymentCommands(program, io, runHandler(io));
  program.commandsGroup("Automations:");
  registerAutomationCommands(program, io, runHandler(io));
  program.commandsGroup("Runs and approvals:");
  registerRunCommands(program, io, runHandler(io));
  program.commandsGroup("Credentials:");
  registerConnectionCommands(program, io, runHandler(io));
  registerCredentialCommands(program, io, runHandler(io));
  program.commandsGroup("Operate the instance:");
  registerAdminCommands(program, io, runHandler(io));
  registerWorkerCommands(program, io, runHandler(io));
  registerSecurityCommand(program, io, runHandler(io));
  registerBackup(program, io, runHandler(io));
  program.commandsGroup("Projects and access:");
  registerAccessCommands(program, io, runHandler(io));
  program.commandsGroup("Set up this machine:");
  registerProfile(program, io, runHandler(io));
  registerSkillCommand(program, io, runHandler(io));
  registerHooksCommand(program, io, runHandler(io));
  registerWorkspaceCommand(program, io, runHandler(io));
  program.commandsGroup("Describe the CLI:");
  registerSchema(program, io);
  registerCommandsMeta(program, io);

  return program;
}

/** Parses and runs one invocation; every answer and every error goes to stdout. */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIO = createNodeIO(),
): Promise<number> {
  const separator = argv.indexOf("--");
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  setOutputFormat(flags.includes("--json") ? "json" : "toon");
  const program = createProgram(io);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (isBrokenPipeError(error)) return 0;
    if (error instanceof HandledCliError) return error.exitCode;
    const agentError =
      error instanceof CommanderError
        ? error.exitCode === 0
          ? null
          : usageError(program, argv, error)
        : toAgentError(error);
    if (agentError === null) return 0;
    try {
      respondError(io, agentError);
    } catch (writeError) {
      if (isBrokenPipeError(writeError)) return 0;
      throw writeError;
    }
    return agentError.exitCode;
  }
}

/** The process entry of bin.ts: real streams, a quiet broken pipe, the exit code. */
export async function runNodeCli(): Promise<void> {
  const exitOnBrokenPipe = (error: NodeJS.ErrnoException) => {
    if (isBrokenPipeError(error)) process.exit(0);
    throw error;
  };
  process.stdout.on("error", exitOnBrokenPipe);
  process.stderr.on("error", exitOnBrokenPipe);
  process.on("SIGPIPE", () => process.exit(0));
  process.exitCode = await runCli();
}

/**
 * A parse error, with what the command accepts folded in, so one more call fixes it: the valid
 * flags for an unknown flag, the subcommands for an unknown command.
 */
function usageError(program: Command, argv: readonly string[], error: CommanderError): AgentError {
  const { command, word } = checkInvocation(program, argv);
  const path = commandPath(command);
  const message = error.message.replace(/^error:\s*/i, "");
  const subcommands = command.commands.map((sub) => sub.name());
  const unknownCommand =
    error.code === "commander.unknownCommand" ||
    (error.code === "commander.excessArguments" && subcommands.length > 0);
  if (unknownCommand) {
    const near = word === undefined ? undefined : nearestCommand(word, subcommands);
    return new AgentError({
      code: "COMMAND_UNKNOWN",
      exitCode: EXIT_CODES.usage,
      fixCommand: near === undefined ? `${path} --help` : `${path} ${near} --help`,
      hint: `Commands under \`${path}\`: ${subcommands.join(", ")}`,
      message:
        word === undefined
          ? message
          : `Unknown command "${word}" under \`${path}\`${near === undefined ? "" : `; did you mean ${near}?`}`,
    });
  }
  const code = COMMANDER_CODES[error.code] ?? "COMMAND_PARSE_ERROR";
  const flags = [...command.options, ...program.options]
    .map((option) => option.long)
    .filter((flag) => flag !== undefined && flag !== "--version");
  return new AgentError({
    code,
    exitCode: EXIT_CODES.usage,
    fixCommand: `${path} --help`,
    hint: `Usage: ${command.name() === "swizzle" ? "swizzle" : `${path} ${command.usage()}`}. Flags: ${flags.join(", ")} (--help always works).`,
    message,
  });
}

/** A typo of `name`: at most two single-character edits away. */
/**
 * The subcommand closest to a mistyped word: at most one edit away for a word of up to four
 * letters, two for a longer one, so `nope` does not suggest `move`.
 */
function nearestCommand(word: string, names: readonly string[]): string | undefined {
  const allowed = word.length <= 4 ? 1 : 2;
  let best: { readonly name: string; readonly distance: number } | undefined;
  for (const name of names) {
    const distance = editDistance(word, name);
    if (distance <= allowed && (best === undefined || distance < best.distance)) {
      best = { distance, name };
    }
  }
  return best?.name;
}

function editDistance(word: string, name: string): number {
  let previous = Array.from({ length: name.length + 1 }, (_, index) => index);
  for (let i = 1; i <= word.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= name.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (word[i - 1] === name[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[name.length] ?? Number.POSITIVE_INFINITY;
}

const COMMANDER_CODES: Readonly<Record<string, string>> = {
  "commander.conflictingOption": "OPTION_CONFLICT",
  "commander.excessArguments": "ARGUMENT_EXCESS",
  "commander.invalidArgument": "ARGUMENT_INVALID",
  "commander.missingArgument": "ARGUMENT_MISSING",
  "commander.missingMandatoryOptionValue": "OPTION_VALUE_MISSING",
  "commander.optionMissingArgument": "OPTION_VALUE_MISSING",
  "commander.unknownOption": "OPTION_UNKNOWN",
};

function runHandler(io: CliIO) {
  return async (handler: () => Promise<void>): Promise<void> => {
    try {
      await handler();
    } catch (error) {
      if (isBrokenPipeError(error)) throw new HandledCliError(0);
      if (error instanceof HandledCliError || error instanceof CommanderError) throw error;
      const agentError = toAgentError(error);
      respondError(io, agentError);
      throw new HandledCliError(agentError.exitCode);
    }
  };
}

// ---------- schema ----------

const SCHEMA_TYPES = ["config", "error", "scaffolds", "runtime-error-codes", "enums", "exit-codes"];

function registerSchema(program: Command, io: CliIO): void {
  const command = program
    .command("schema")
    .description("Print a machine-readable schema: config.yaml, errors, enums, exit codes")
    .argument("<type>", SCHEMA_TYPES.join(" | "));
  localCommand(command);
  withExamples(command, ["swizzle schema config --json", "swizzle schema exit-codes"]);
  command.action(async (type: string) => {
    await runHandler(io)(async () => {
      respond(io, buildSchema(type));
    });
  });
}

// ---------- commands (self-describe) ----------

function registerCommandsMeta(program: Command, io: CliIO): void {
  const command = program
    .command("commands")
    .description("Print the whole command tree with arguments, flags and examples");
  localCommand(command);
  withExamples(command, ["swizzle commands --json", "swizzle commands"]);
  command.action(() => {
    respond(io, describeCommandTree(program) as unknown as Record<string, unknown>);
  });
}

// ---------- schema builder ----------

function buildSchema(type: string): Record<string, unknown> {
  switch (type) {
    case "config":
      return createAutomationConfigJsonSchema();
    case "scaffolds":
      return getSerializableScaffoldCatalog() as unknown as Record<string, unknown>;
    case "error":
      return {
        $id: "https://swizzle.dev/schemas/cli-error.v2.json",
        $schema: "https://json-schema.org/draft/2020-12/schema",
        description:
          "What a failing command prints on stdout (TOON, or JSON under --json), with a non-zero exit code.",
        properties: {
          code: { type: "string" },
          details: { type: "object" },
          error: { description: "What went wrong", type: "string" },
          help: {
            description: "Next steps: the command that fixes it first, then the hint",
            items: { type: "string" },
            minItems: 1,
            type: "array",
          },
          retryable: { const: true, description: "Present only when a retry can succeed" },
          warnings: { items: { type: "string" }, type: "array" },
        },
        required: ["error", "code", "help"],
        title: "SwizzleCliError",
        type: "object",
      };
    case "runtime-error-codes":
      return {
        codes: [
          "ACTIVE_DEPLOYMENT_NOT_FOUND",
          "AUTOMATION_CONFIG_INVALID",
          "AUTOMATION_CONFIG_NOT_FOUND",
          "AUTOMATION_ENTRYPOINT_NOT_FOUND",
          "AUTOMATION_ENTRYPOINT_OUTSIDE_DIRECTORY",
          "AUTOMATION_ENTRYPOINT_UNSUPPORTED",
          "DEPENDENCY_MANIFEST_MISSING",
          "DEPENDENCY_PACKAGING_FAILED",
          "DEPLOYMENT_ARTIFACTS_MISSING",
          "DEPLOYMENT_MANIFEST_INVALID",
          "DEPLOYMENT_NOT_FOUND",
          "DEPLOYMENT_SOURCE_EMPTY",
          "INTERPRETER_NOT_FOUND",
          "INVALID_ENCRYPTION_KEY",
          "INVALID_PAYLOAD_FILE_JSON",
          "INVALID_PAYLOAD_JSON",
          "LANGUAGE_RUNTIME_UNAVAILABLE",
          "MISSING_ENCRYPTION_KEY",
          "MISSING_REQUIRED_SECRETS",
          "PAYLOAD_OPTIONS_CONFLICT",
          "PLATFORM_REQUIRED_SECRETS_MISSING",
          "PROCESS_EXIT_NON_ZERO",
          "PROCESS_OUTPUT_LIMIT_EXCEEDED",
          "PROCESS_SIGNAL",
          "PROCESS_STDOUT_EMPTY",
          "PROCESS_STDOUT_INVALID_JSON",
          "PROCESS_TIMEOUT",
          "ROLLBACK_CONFLICT",
          "RUN_NOT_FOUND",
          "RUNTIME_TIMEOUT_EXCEEDS_MAX",
          "RUNTIME_REQUIREMENTS_UNMET",
          "TIMEOUT_FORMAT_INVALID",
          "TRIGGER_CONFIGURATION_INVALID",
          "TRIGGER_NOT_FIRABLE",
          "TRIGGER_NOT_FOUND",
          "TRIGGER_PAUSED",
          "TRIGGER_WEBHOOK_PATH_CONFLICT",
          "TRIGGER_WEBHOOK_PATH_RESERVED",
          "UNEXPECTED_RUNTIME_ERROR",
          "WEBHOOK_PAYLOAD_INVALID",
        ],
        description: "Known AutomationRuntimeError codes surfaced to agents.",
      };
    case "enums":
      return {
        executionModes: [...AUTOMATION_RUNTIME_EXECUTION_MODES],
        languages: [...AUTOMATION_RUNTIME_LANGUAGES],
        runStatuses: RUN_STATUSES,
        triggerStatuses: ["active", "paused", "missing", "invalid"],
        triggerTypes: [...AUTOMATION_TRIGGER_TYPES],
      };
    case "exit-codes":
      return {
        codes: {
          "0": "success, including a no-op",
          "1": "generic or unexpected error",
          "2": "usage error (unknown command, bad arguments or flags, missing --yes)",
          "3": "validation error (config, payload, or request shape)",
          "4": "auth error (missing or invalid token, access denied)",
          "5": "backend error (API unreachable, timeout, 5xx)",
          "6": "not found (automation, run, deployment, secret)",
          "7": "rate limit exceeded",
          "8": "conflict (already exists, paused trigger, ambiguous name)",
        },
        description:
          "Process exit codes by failure class, so an agent can tell retry from fix without reading the output.",
      };
    default:
      throw new AgentError({
        code: "UNKNOWN_SCHEMA_TYPE",
        exitCode: EXIT_CODES.usage,
        fixCommand: "swizzle schema config",
        hint: `Valid types: ${SCHEMA_TYPES.join(", ")}.`,
        message: `Unknown schema type: ${type}`,
      });
  }
}

function createNodeIO(): CliIO {
  return {
    stderr: (message) => writeNodeStream(process.stderr, message),
    stdout: (message) => writeNodeStream(process.stdout, message),
  };
}

function writeNodeStream(stream: NodeJS.WriteStream, message: string): void {
  try {
    stream.write(message);
  } catch (error) {
    if (isBrokenPipeError(error)) throw new HandledCliError(0);
    throw error;
  }
}

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EPIPE"
  );
}
