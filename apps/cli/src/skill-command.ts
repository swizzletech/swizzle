/**
 * `swizzle skill install`: copies the packaged swizzle-builder skill into a workspace's
 * `.agents/skills/` and links `.claude/skills` to it. An identical copy is a no-op; a changed one
 * is replaced only with `--force`. `workspace init` installs it the same way.
 */
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import {
  localCommand,
  type RunHandler,
  showsSubcommands,
  withExamples,
} from "./command-support.js";
import { AgentError, type CliIO, EXIT_CODES, respond } from "./output.js";
import { resolveCliAssetDirectory } from "./package-assets.js";

const SKILL_NAME = "swizzle-builder";

interface SkillInstallResult {
  readonly state: "installed" | "replaced" | "already installed (no-op)" | "symlink left unchanged";
  readonly claudeSkills: {
    readonly action: "created" | "existing" | "skipped-existing-path" | "failed";
    readonly path: string;
    readonly reason?: string;
    readonly target: string;
  };
  readonly source: string;
  readonly target: string;
  readonly workspace: string;
}

export function registerSkillCommand(program: Command, io: CliIO, runHandler: RunHandler): void {
  const skill = localCommand(
    program.command("skill").description("Install the packaged Swizzle agent skill"),
  );
  showsSubcommands(skill);
  withExamples(skill, ["swizzle skill install", "swizzle skill install --dir ../automations"]);

  const install = localCommand(
    skill
      .command("install")
      .description(
        "Copy the swizzle-builder skill into a workspace's .agents/skills; an identical copy is a no-op",
      )
      .option("--dir <path>", "Workspace directory (default: .)")
      .option("--force", "Replace a copy that differs from the packaged skill"),
  );
  withExamples(install, [
    "swizzle skill install",
    "swizzle skill install --dir ../automations --force --json",
  ]);
  install.action(async (options: { readonly dir?: string; readonly force?: boolean }) => {
    await runHandler(async () => {
      const result = await installSwizzleSkill({
        force: options.force === true,
        workspaceDirectory: options.dir ?? ".",
      });
      respond(io, {
        skill: {
          name: SKILL_NAME,
          state: result.state,
          target: result.target,
          claudeSkills:
            result.claudeSkills.reason === undefined
              ? `${result.claudeSkills.action}: ${result.claudeSkills.path} -> ${result.claudeSkills.target}`
              : `${result.claudeSkills.action}: ${result.claudeSkills.path} (${result.claudeSkills.reason})`,
        },
      });
    });
  });
}

export async function installSwizzleSkill(input: {
  readonly force: boolean;
  readonly workspaceDirectory: string;
}): Promise<SkillInstallResult> {
  const workspace = path.resolve(input.workspaceDirectory);
  const source = await resolveCliAssetDirectory(`skills/${SKILL_NAME}`);
  const skillsDirectory = path.join(workspace, ".agents/skills");
  const target = path.join(skillsDirectory, SKILL_NAME);

  await mkdir(skillsDirectory, { recursive: true });
  const targetState = await getPathState(target);
  const state = await (async (): Promise<SkillInstallResult["state"]> => {
    if (targetState?.isSymbolicLink()) return "symlink left unchanged";
    if (targetState === undefined) {
      await cp(source, target, { recursive: true });
      return "installed";
    }
    if (targetState.isDirectory() && (await sameTree(source, target))) {
      return "already installed (no-op)";
    }
    if (!input.force) {
      throw new AgentError({
        code: "SKILL_CHANGED",
        exitCode: EXIT_CODES.conflict,
        fixCommand: `swizzle skill install --dir ${input.workspaceDirectory} --force`,
        hint: "The installed copy differs from this CLI's skill, from an older CLI or a local edit. --force replaces it.",
        message: `A different ${SKILL_NAME} skill is already installed at ${target}.`,
      });
    }
    await rm(target, { force: true, recursive: true });
    await cp(source, target, { recursive: true });
    return "replaced";
  })();

  return {
    claudeSkills: await ensureClaudeSkillsSymlink(workspace),
    source,
    state,
    target,
    workspace,
  };
}

/** Whether two directories hold the same entries, each of the same kind, and files of the same bytes. */
async function sameTree(left: string, right: string): Promise<boolean> {
  const entries = async (root: string) =>
    (await readdir(root, { recursive: true, withFileTypes: true }))
      .map(
        (entry) =>
          `${entryKind(entry)} ${path.relative(root, path.join(entry.parentPath, entry.name))}`,
      )
      .sort();
  const [leftEntries, rightEntries] = await Promise.all([entries(left), entries(right)]);
  if (leftEntries.join("\n") !== rightEntries.join("\n")) return false;
  for (const entry of leftEntries) {
    if (!entry.startsWith("file ")) continue;
    const file = entry.slice("file ".length);
    const [a, b] = await Promise.all([
      readFile(path.join(left, file)),
      readFile(path.join(right, file)),
    ]);
    if (!a.equals(b)) return false;
  }
  return true;
}

function entryKind(entry: Dirent): string {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return "other";
}

async function ensureClaudeSkillsSymlink(
  workspace: string,
): Promise<SkillInstallResult["claudeSkills"]> {
  const claudeDirectory = path.join(workspace, ".claude");
  const linkPath = path.join(claudeDirectory, "skills");
  const target = "../.agents/skills";
  await mkdir(claudeDirectory, { recursive: true });

  const linkState = await getPathState(linkPath);
  if (linkState?.isSymbolicLink()) {
    return { action: "existing", path: linkPath, target };
  }
  if (linkState !== undefined) {
    return {
      action: "skipped-existing-path",
      path: linkPath,
      reason: "Path exists and is not a symlink.",
      target,
    };
  }

  try {
    await symlink(target, linkPath, "dir");
    return { action: "created", path: linkPath, target };
  } catch (error) {
    return {
      action: "failed",
      path: linkPath,
      reason: error instanceof Error ? error.message : String(error),
      target,
    };
  }
}

async function getPathState(target: string) {
  return await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}
