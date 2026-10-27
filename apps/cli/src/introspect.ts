/**
 * The command tree as data: `swizzle commands` prints it, `just gen` renders docs/reference/cli.md
 * from it, and `checkInvocation` walks a written command through it, so error messages, help
 * examples and the builder skill name only commands and flags that exist.
 */
import type { Command, Option } from "commander";

import { examplesOf } from "./command-support.js";

interface CommandDescriptor {
  readonly name: string;
  readonly path: readonly string[];
  readonly description: string;
  readonly arguments: readonly CommandArgumentDescriptor[];
  readonly options: readonly CommandOptionDescriptor[];
  readonly examples: readonly string[];
  readonly subcommands: readonly CommandDescriptor[];
}

interface CommandArgumentDescriptor {
  readonly name: string;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly description: string;
}

interface CommandOptionDescriptor {
  readonly flags: string;
  readonly long: string | null;
  readonly short: string | null;
  readonly description: string;
  readonly required: boolean;
  readonly optional: boolean;
  readonly negate: boolean;
  readonly argumentName: string | null;
  readonly defaultValue: unknown;
}

export interface CommandTree {
  readonly command: string;
  readonly description: string;
  readonly version: string;
  readonly commands: readonly CommandDescriptor[];
}

export function describeCommandTree(program: Command): CommandTree {
  const commands = program.commands.map((command) => describeCommand(command, [program.name()]));
  return {
    command: program.name(),
    commands,
    description: program.description() ?? "",
    version: program.version() ?? "0.0.0",
  };
}

function describeCommand(command: Command, parentPath: readonly string[]): CommandDescriptor {
  const path = [...parentPath, command.name()];
  return {
    arguments: command.registeredArguments.map((argument) => ({
      description: argument.description,
      name: argument.name(),
      required: argument.required,
      variadic: argument.variadic,
    })),
    description: command.description() ?? "",
    examples: examplesOf(command),
    name: command.name(),
    options: command.options.map(describeOption),
    path,
    subcommands: command.commands.map((sub) => describeCommand(sub, path)),
  };
}

export function describeOption(option: Option): CommandOptionDescriptor {
  return {
    argumentName: option.required || option.optional ? extractArgName(option.flags) : null,
    defaultValue: option.defaultValue ?? null,
    description: option.description,
    flags: option.flags,
    long: option.long ?? null,
    negate: option.negate,
    optional: option.optional,
    required: option.required,
    short: option.short ?? null,
  };
}

function extractArgName(flags: string): string | null {
  const match = /<([^>]+)>|\[([^\]]+)\]/.exec(flags);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/** Where a written command lands in the tree, and the first part of it the tree does not know. */
export interface Invocation {
  readonly command: Command;
  readonly problem: string | null;
  /** The word the tree does not know, when the problem is a command or an argument. */
  readonly word?: string;
}

/**
 * Walks `swizzle --profile prod a b c --flag value` (without `swizzle`) through the tree the way
 * commander parses it: a flag must exist on the resolved command, an ancestor, or the default
 * subcommand it dispatches to, and takes its value; words descend into subcommands, and once none
 * matches, each further word must be a positional the resolved command declares.
 */
export function checkInvocation(program: Command, words: readonly string[]): Invocation {
  let command = program;
  const chain = [program];
  let positionals = 0;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "--") break;
    if (word.startsWith("-") && word.length > 1) {
      const flag = word.split("=")[0] ?? word;
      if (flag === "--help" || flag === "-h") continue;
      const owners = [...chain.slice(0, -1), ...withDefaultSubcommand(command)];
      const option = owners
        .flatMap((owner) => owner.options)
        .find((candidate) => candidate.long === flag || candidate.short === flag);
      if (option === undefined) {
        return { command, problem: `unknown flag ${flag} on "${commandPath(command)}"` };
      }
      const next = words[index + 1];
      const takesNext = option.required || (option.optional && next?.startsWith("-") !== true);
      if (takesNext && !word.includes("=")) index += 1;
      continue;
    }
    if (positionals === 0) {
      const subcommand = command.commands.find(
        (candidate) => candidate.name() === word || candidate.aliases().includes(word),
      );
      if (subcommand !== undefined) {
        command = subcommand;
        chain.push(subcommand);
        continue;
      }
    }
    const target = withDefaultSubcommand(command).at(-1) ?? command;
    const declared = target.registeredArguments;
    if (positionals >= declared.length && declared.at(-1)?.variadic !== true) {
      return {
        command,
        word,
        problem:
          target.commands.length > 0
            ? `unknown command ${word} under "${commandPath(command)}"`
            : `unexpected argument ${word} for "${commandPath(target)}"`,
      };
    }
    positionals += 1;
  }

  return { command, problem: null };
}

/** `swizzle runs list`, as a person types it. */
export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current !== null; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(" ");
}

function withDefaultSubcommand(command: Command): Command[] {
  // Commander keeps `{ isDefault: true }` only in this field; `swizzle runs --status`
  // parses as `swizzle runs list --status`.
  const name = (command as Command & { _defaultCommandName?: string })._defaultCommandName;
  const fallback = command.commands.find((candidate) => candidate.name() === name);
  return fallback === undefined ? [command] : [command, fallback];
}
