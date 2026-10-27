import { type Command, InvalidArgumentError } from "commander";

import { resolveApiUrl } from "./api.js";
import { AgentError, EXIT_CODES } from "./output.js";

export const DEFAULT_API_URL = process.env.SWIZZLE_API_URL ?? "http://api.localhost:19826";

/**
 * The target every command reads. `--api-url`, `--profile`, `-e` and `--debug` are global flags;
 * the preAction hook in main.ts resolves the profile and copies them onto the command it runs.
 */
export interface ApiCommandOptions {
  readonly apiUrl?: string;
  readonly environment?: string;
  readonly profile?: string;
  readonly debug?: boolean;
}

export interface ExactCommandOptions {
  readonly exact?: boolean;
}

export interface FieldsCommandOptions {
  readonly fields?: string;
}

export interface PaginationCommandOptions {
  readonly limit?: number;
}

export interface TimeRangeCommandOptions {
  readonly since?: string;
  readonly until?: string;
}

/** Option parser for a positive whole number such as `--limit 20`; anything else is a usage error. */
export function parseCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new InvalidArgumentError("Expected a positive whole number.");
  }
  return count;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Argument parser for a run id, which the API takes only as a UUID; anything else is a usage error. */
export function parseRunId(value: string): string {
  if (!UUID.test(value)) {
    throw new InvalidArgumentError("Run ids are UUIDs; `swizzle runs` lists them.");
  }
  return value;
}

/** Runs a command's work and prints any error it throws as the structured error output. */
export type RunHandler = (handler: () => Promise<void>) => Promise<void>;

export function buildApiUrl(
  pathname: string,
  options: ApiCommandOptions,
  extraQuery?: Record<string, string | number | boolean>,
): string {
  const url = resolveApiUrl(options.apiUrl ?? DEFAULT_API_URL, pathname);
  if (options.environment !== undefined) url.searchParams.set("environment", options.environment);
  if (extraQuery) {
    for (const [key, value] of Object.entries(extraQuery)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** The URL of a route that takes no environment, such as the access routes. */
export function buildAccessApiUrl(
  pathname: string,
  options: ApiCommandOptions,
  query?: Record<string, string>,
): string {
  const { environment: _environment, ...withoutEnvironment } = options;
  return buildApiUrl(pathname, withoutEnvironment, query);
}

/** `--fields a,b`: the columns a list adds to its default ones. */
export function addFieldsOption(command: Command, defaults: readonly string[]): Command {
  return command.option(
    "--fields <names>",
    `Comma-separated extra columns (default: ${defaults.join(",")})`,
  );
}

const examplesByCommand = new WeakMap<Command, readonly string[]>();

/**
 * Two or more complete invocations, printed under `--help` and in the generated CLI reference. A
 * test walks each through the command tree, so an example names only real commands and flags.
 */
export function withExamples(
  command: Command,
  examples: readonly [string, string, ...string[]],
): Command {
  examplesByCommand.set(command, examples);
  return command.addHelpText(
    "after",
    `\nExamples:\n${examples.map((example) => `  ${example}`).join("\n")}\n`,
  );
}

export function examplesOf(command: Command): readonly string[] {
  return examplesByCommand.get(command) ?? [];
}

/** A command group without a list of its own prints its subcommands, on stdout. */
export function showsSubcommands(command: Command): Command {
  return command.action(() => {
    command.outputHelp();
  });
}

const localCommands = new WeakSet<Command>();

/** Marks local work or public enrollment that can run without a stored CLI profile. */
export function localCommand(command: Command): Command {
  localCommands.add(command);
  return command;
}

export function isLocalCommand(command: Command): boolean {
  return localCommands.has(command);
}

/**
 * A destructive command runs only with `--yes`. Without it, the error states what would happen and
 * names the exact command that confirms it; nothing ever prompts.
 */
/** A value as one POSIX shell word, so a suggested command that carries it runs as shown. */
export function shellWord(value: string): string {
  return /^[\w./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function requireYes(yes: boolean | undefined, command: string, consequence: string): void {
  if (yes === true) return;
  throw new AgentError({
    code: "CONFIRMATION_REQUIRED",
    exitCode: EXIT_CODES.usage,
    fixCommand: `${command} --yes`,
    message: `Refusing without --yes: ${consequence}`,
  });
}

/**
 * Runs a removal and answers whether it removed anything. The API's error `code` for "nothing to
 * remove" reads as false, so a repeated delete or revoke answers as a no-op with exit 0.
 */
export async function removeUnlessAbsent(
  code: string,
  removal: Promise<unknown>,
): Promise<boolean> {
  try {
    await removal;
    return true;
  } catch (error) {
    if (error instanceof AgentError && error.code === code) return false;
    throw error;
  }
}
