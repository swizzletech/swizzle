import { type Command, InvalidArgumentError } from "commander";

import { DEFAULT_API_URL, resolveApiUrl } from "./api.js";
import { AgentError, EXIT_CODES } from "./output.js";

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

export function parseCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new InvalidArgumentError("Expected a positive whole number.");
  }
  return count;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseRunId(value: string): string {
  if (!UUID.test(value)) {
    throw new InvalidArgumentError("Run ids are UUIDs; `swizzle runs` lists them.");
  }
  return value;
}

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

export function buildAccessApiUrl(
  pathname: string,
  options: ApiCommandOptions,
  query?: Record<string, string>,
): string {
  const { environment: _environment, ...withoutEnvironment } = options;
  return buildApiUrl(pathname, withoutEnvironment, query);
}

export function addFieldsOption(command: Command, defaults: readonly string[]): Command {
  return command.option(
    "--fields <names>",
    `Comma-separated extra columns (default: ${defaults.join(",")})`,
  );
}

const examplesByCommand = new WeakMap<Command, readonly string[]>();

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

export function showsSubcommands(command: Command): Command {
  return command.action(() => {
    command.outputHelp();
  });
}

const localCommands = new WeakSet<Command>();

export function localCommand(command: Command): Command {
  localCommands.add(command);
  return command;
}

export function isLocalCommand(command: Command): boolean {
  return localCommands.has(command);
}

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
