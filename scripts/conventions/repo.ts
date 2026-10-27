import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  dockerfileRunCommands,
  justRecipes,
  markdownParts,
  type Recipe,
  type ShellCommand,
  shellCommands,
  workflowCommands,
} from "./parse.js";

/** Where a shell command was found, which decides the rules that read it. */
type CommandSource =
  | "markdown-span"
  | "markdown-block"
  | "workflow"
  | "recipe"
  | "script"
  | "dockerfile";

/** A shell command the repository runs or teaches, with the file and line it is on. */
interface FoundCommand {
  readonly file: string;
  readonly line: number;
  readonly words: readonly string[];
  readonly source: CommandSource;
}

/** The repository as the rules read it: a git checkout, or a planted one in the tests. */
export interface Repo {
  /** Repo-relative POSIX paths of the files the rules read. */
  readonly files: readonly string[];
  read(file: string): string;
  /** A file of `files`, or a directory that holds one. */
  exists(target: string): boolean;
  /** Every recipe of the root justfile; none without one. */
  recipes(): readonly Recipe[];
  /** Every shell command in Markdown code, workflows, recipes, shell scripts and Dockerfile RUNs. */
  commands(): readonly FoundCommand[];
}

/** Fenced blocks in these languages, or in none, hold commands; other blocks hold code or output. */
const SHELL_LANGS = new Set(["", "bash", "console", "sh", "shell", "zsh"]);

/** Reads `files` (repo-relative, POSIX) under `root`. */
export function readRepo(root: string, files: readonly string[]): Repo {
  const known = new Set(
    files.flatMap((file) => file.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"))),
  );
  const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
  let recipes: readonly Recipe[] | undefined;
  let commands: readonly FoundCommand[] | undefined;
  const repo: Repo = {
    files,
    read,
    exists: (target) => target === "" || known.has(target),
    recipes: () => {
      recipes ??= known.has("justfile")
        ? justRecipes(path.join(root, "justfile"), read("justfile"))
        : [];
      return recipes;
    },
    commands: () => {
      commands ??= files.flatMap((file) => commandsOf(repo, file));
      return commands;
    },
  };
  return repo;
}

function commandsOf(repo: Repo, file: string): FoundCommand[] {
  const at = (source: CommandSource, startLine: number) => (command: ShellCommand) => ({
    file,
    line: startLine + command.line - 1,
    words: command.words,
    source,
  });
  const base = path.posix.basename(file);
  if (file === "justfile") {
    return repo
      .recipes()
      .flatMap((recipe) => shellCommands(recipe.script).map(at("recipe", recipe.line + 1)));
  }
  if (/^\.github\/(workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/u.test(file)) {
    return workflowCommands(repo.read(file)).map(at("workflow", 1));
  }
  if (base.endsWith(".sh")) return shellCommands(repo.read(file)).map(at("script", 1));
  if (base.includes("Dockerfile"))
    return dockerfileRunCommands(repo.read(file)).map(at("dockerfile", 1));
  if (!base.endsWith(".md")) return [];
  return markdownParts(repo.read(file)).flatMap((part) => {
    if (part.kind === "heading" || (part.kind === "block" && !SHELL_LANGS.has(part.lang)))
      return [];
    const source = part.kind === "span" ? "markdown-span" : "markdown-block";
    // Docs mark a command line with a `$ ` prompt, and write a placeholder as `<run-id>`: one
    // word, where bash would read two redirections and drop every flag after it.
    return shellCommands(part.text.replace(/<([A-Za-z][\w.|-]*)>/gu, "$1"))
      .map((command) =>
        command.words[0] === "$" ? { ...command, words: command.words.slice(1) } : command,
      )
      .filter((command) => command.words.length > 0)
      .map(at(source, part.line));
  });
}

/**
 * The tracked files of the checkout at `root`, staged ones included. Untracked files stay out, so
 * an agent's working notes never turn `just check` red; `git add` brings a new file in.
 */
export function gitRepo(root: string): Repo {
  const files = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8" })
    .split("\0")
    // A file deleted in the worktree stays listed until the deletion is staged.
    .filter((file) => file !== "" && existsSync(path.join(root, file)));
  return readRepo(root, files);
}
