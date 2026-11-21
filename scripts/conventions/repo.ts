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

type CommandSource =
  | "markdown-span"
  | "markdown-block"
  | "workflow"
  | "recipe"
  | "script"
  | "dockerfile";

interface FoundCommand {
  readonly file: string;
  readonly line: number;
  readonly words: readonly string[];
  readonly source: CommandSource;
}

export interface Repo {
  readonly files: readonly string[];
  read(file: string): string;
  readBaseline?(file: string): string | undefined;
  exists(target: string): boolean;
  recipes(): readonly Recipe[];
  commands(): readonly FoundCommand[];
}

const SHELL_LANGS = new Set(["", "bash", "console", "sh", "shell", "zsh"]);

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
    return shellCommands(part.text.replace(/<([A-Za-z][\w.|-]*)>/gu, "$1"))
      .map((command) =>
        command.words[0] === "$" ? { ...command, words: command.words.slice(1) } : command,
      )
      .filter((command) => command.words.length > 0)
      .map(at(source, part.line));
  });
}

export function gitRepo(root: string): Repo {
  const files = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "" && existsSync(path.join(root, file)));
  return { ...readRepo(root, files), readBaseline: (file) => readBaseline(root, file) };
}

function readBaseline(root: string, file: string): string | undefined {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return undefined;
    }
  };
  const base =
    git(["merge-base", "HEAD", "refs/heads/main"])?.trim() ??
    git(["merge-base", "HEAD", "refs/remotes/origin/main"])?.trim();
  if (!base) return undefined;
  const baseline = git(["show", `${base}:${file}`]);
  if (baseline !== undefined) return baseline;
  const [introduced] =
    git([
      "log",
      "--topo-order",
      "--reverse",
      "--no-renames",
      "--diff-filter=A",
      "--format=%H",
      `${base}..HEAD`,
      "--",
      file,
    ])?.split("\n") ?? [];
  return introduced ? git(["show", `${introduced}:${file}`]) : undefined;
}
