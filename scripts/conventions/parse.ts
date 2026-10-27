// The formats the conventions read, each through its real parser: Markdown through marked, shell
// through unbash, workflow YAML through yaml and the justfile through `just --dump`. A rule asks
// these readers and never matches the syntax itself, so it reads a file the way its tool does.
// scripts/agent-reference-drift.test.ts reads the shipped skill through the same functions.

import { execFileSync } from "node:child_process";
import { lexer, type Token, walkTokens } from "marked";
import { type Command, forEachChild, parse as parseShell, type SyntaxNode } from "unbash";
import { isScalar, LineCounter, parseDocument, Scalar, visit } from "yaml";

/** 1-based line of a character offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (
    let index = text.indexOf("\n");
    index !== -1 && index < offset;
    index = text.indexOf("\n", index + 1)
  ) {
    line += 1;
  }
  return line;
}

/**
 * What a Markdown file shows as code, and its headings, in document order. `line` is the line the
 * text starts on, for a block its first content line; a block's text excludes the fences.
 */
export type MarkdownPart =
  | {
      readonly kind: "heading";
      readonly line: number;
      readonly text: string;
      readonly depth: number;
    }
  | { readonly kind: "span"; readonly line: number; readonly text: string }
  /** `lang` is the info string of a fenced block, such as `bash`; empty for an indented block. */
  | { readonly kind: "block"; readonly line: number; readonly text: string; readonly lang: string };

/** Headings, code spans and code blocks of a Markdown file, as a CommonMark parser reads them. */
export function markdownParts(markdown: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  // marked keeps no positions, but each token's raw text is the source it came from: top-level
  // tokens concatenate to the file, and a nested token sits inside its top-level block.
  let blockStart = 0;
  for (const block of lexer(markdown)) {
    const blockEnd = blockStart + block.raw.length;
    let cursor = blockStart;
    // A nested block loses its indentation in `raw`, so a code block is found by its first line,
    // which starts a source line after indentation and blockquote markers: earlier prose in the
    // same list item may hold the same text.
    const at = (needle: string, lineStart = false): number => {
      let found = needle === "" ? -1 : markdown.indexOf(needle, cursor);
      while (
        lineStart &&
        found !== -1 &&
        !/^[\s>]*$/u.test(markdown.slice(markdown.lastIndexOf("\n", found - 1) + 1, found))
      )
        found = markdown.indexOf(needle, found + 1);
      if (found === -1 || found >= blockEnd) return blockStart;
      cursor = found + needle.length;
      return found;
    };
    walkTokens([block], (token: Token) => {
      if (token.type === "heading") {
        parts.push({
          kind: "heading",
          line: lineAt(markdown, blockStart),
          text: token.text,
          depth: token.depth,
        });
      } else if (token.type === "codespan") {
        parts.push({ kind: "span", line: lineAt(markdown, at(token.raw)), text: token.text });
      } else if (token.type === "code") {
        const text = token.text.replace(/\n$/u, "");
        const first = text.split("\n")[0] ?? "";
        const fenced = token.codeBlockStyle !== "indented";
        // Content starts after the opening fence, which may itself contain the first line's text.
        const fence = fenced ? at(token.raw.split("\n")[0] ?? "") : blockStart;
        const line = first === "" ? lineAt(markdown, fence) + 1 : lineAt(markdown, at(first, true));
        parts.push({ kind: "block", line, text, lang: fenced ? (token.lang ?? "") : "" });
      }
    });
    blockStart = blockEnd;
  }
  return parts;
}

/** A simple command as the shell runs it: its words after quote removal, and the line it starts on. */
export interface ShellCommand {
  readonly words: readonly string[];
  /** 1-based, within the script that was parsed. */
  readonly line: number;
}

function commandsIn(node: SyntaxNode, source: string, found: ShellCommand[]): ShellCommand[] {
  if (node.type === "Command") {
    found.push({ words: wordsOf(node), line: lineAt(source, node.pos) });
  }
  forEachChild(node, (child) => {
    commandsIn(child, source, found);
  });
  return found;
}

function wordsOf(command: Command): string[] {
  const args = command.args.flatMap((arg) => (arg.type === "Word" ? [arg.value] : []));
  return command.name === undefined ? args : [command.name.value, ...args];
}

/**
 * Every simple command of a bash script in source order, those inside `$(...)` included.
 * Lists, pipelines, comments and backslash continuations end or join commands as in bash.
 */
export function shellCommands(script: string): ShellCommand[] {
  return commandsIn(parseShell(script), script, []).filter(({ words }) => words.length > 0);
}

/**
 * The commands of a Dockerfile's RUN instructions, in either case. Instructions parse as shell
 * words, with `\` continuing a line as in the shell; RUN and its own `--flags` are dropped. A body
 * that is a JSON array of strings is the exec form, as Docker decides it, and is one command.
 */
export function dockerfileRunCommands(dockerfile: string): ShellCommand[] {
  return parseShell(dockerfile).commands.flatMap((statement) => {
    const [first, ...rest] = commandsIn(statement, dockerfile, []);
    if (first?.words[0]?.toUpperCase() !== "RUN") return [];
    const command = statement.command;
    const body =
      command.type === "Command"
        ? command.args.find((arg) => arg.type === "Word" && !arg.value.startsWith("--"))
        : undefined;
    const exec = body === undefined ? undefined : execForm(dockerfile.slice(body.pos, command.end));
    if (exec !== undefined) return exec.length > 0 ? [{ words: exec, line: first.line }] : [];
    const words = first.words.slice(1);
    const flags = words.findIndex((word) => !word.startsWith("--"));
    return [{ ...first, words: flags === -1 ? [] : words.slice(flags) }, ...rest].filter(
      ({ words: w }) => w.length > 0,
    );
  });
}

function execForm(body: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return Array.isArray(value) && value.every((word) => typeof word === "string")
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** The commands of a GitHub workflow's or action's `run:` scripts, with their lines in the file. */
export function workflowCommands(yamlText: string): ShellCommand[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(yamlText, { lineCounter });
  const found: ShellCommand[] = [];
  visit(document, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || pair.key.value !== "run") return;
      const value = pair.value;
      if (!isScalar(value) || typeof value.value !== "string" || !value.range) return;
      const [start, end] = value.range;
      const startLine = lineCounter.linePos(start).line;
      const commands = shellCommands(value.value);
      if (value.type === Scalar.BLOCK_LITERAL) {
        // Content starts on the line after the `|` indicator and keeps the source's line breaks.
        found.push(...commands.map((command) => ({ ...command, line: startLine + command.line })));
        return;
      }
      // Any other scalar may fold source lines together, so each command is found by its words.
      let cursor = start;
      for (const command of commands) {
        const offsets = command.words.map((word) => {
          const offset = yamlText.indexOf(word, cursor);
          if (offset === -1 || offset >= end) return start;
          cursor = offset + word.length;
          return offset;
        });
        found.push({ ...command, line: lineCounter.linePos(offsets[0] ?? start).line });
      }
    },
  });
  return found;
}

/** A recipe of a justfile, as `just` reads it. */
export interface Recipe {
  readonly name: string;
  /** The doc comment `just --list` shows beside the recipe. */
  readonly doc: string | undefined;
  readonly private: boolean;
  /** The line of the recipe header, such as `test *args:`. */
  readonly line: number;
  /** The body as bash receives it, `{{ … }}` interpolations as the word `{{}}`; empty for a shebang recipe. */
  readonly script: string;
}

/** The fields of `just --dump --dump-format json` the conventions read. */
interface JustDump {
  readonly recipes: Record<
    string,
    {
      readonly name: string;
      readonly doc: string | null;
      readonly private: boolean;
      readonly shebang: boolean;
      readonly attributes: readonly unknown[];
      /** Lines of string fragments and interpolation expressions. */
      readonly body: ReadonlyArray<ReadonlyArray<unknown>>;
    }
  >;
}

/** Every recipe of the justfile at `justfilePath`; `text` is its content, to place each header. */
export function justRecipes(justfilePath: string, text: string): Recipe[] {
  const dump = JSON.parse(
    execFileSync("just", ["--justfile", justfilePath, "--dump", "--dump-format", "json"], {
      encoding: "utf8",
    }),
  ) as JustDump;
  const lines = text.split("\n");
  return Object.values(dump.recipes).map((recipe) => {
    // `just` selects the OS variant. Bare attributes identify its source header;
    // attributes with arguments are objects in the dump and do not identify the OS.
    const selected = recipe.attributes
      .filter((attribute): attribute is string => typeof attribute === "string")
      .toSorted();
    const header = lines.findIndex((line, index) => {
      if (
        ![recipe.name, `@${recipe.name}`].some(
          (name) => line.startsWith(name) && [" ", ":"].includes(line.charAt(name.length)),
        )
      )
        return false;
      const attributes: string[] = [];
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const text = lines[previous] ?? "";
        if (text.startsWith("#")) continue;
        if (!text.startsWith("[")) break;
        for (const match of text.matchAll(/(?:\[|,)\s*([a-z][a-z-]*)(?=\s*[,\]])/gu)) {
          if (match[1] !== undefined) attributes.push(match[1]);
        }
      }
      return attributes.toSorted().join(",") === selected.join(",");
    });
    return {
      name: recipe.name,
      doc: recipe.doc ?? undefined,
      private: recipe.private,
      line: header + 1,
      // A shebang recipe runs another interpreter, so its body is no bash to read.
      script: recipe.shebang ? "" : recipeScript(recipe.body),
    };
  });
}

/** Joins a dumped body into the script bash receives: line by line, with just's `@` and `-` prefixes dropped. */
function recipeScript(body: ReadonlyArray<ReadonlyArray<unknown>>): string {
  let continued = false;
  return body
    .map((fragments) => {
      let line = fragments
        .map((fragment) => (typeof fragment === "string" ? fragment : "{{}}"))
        .join("");
      if (!continued && (line.startsWith("@") || line.startsWith("-"))) line = line.slice(1);
      continued = line.endsWith("\\");
      return line;
    })
    .join("\n");
}
