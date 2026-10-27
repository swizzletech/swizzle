/**
 * `swizzle workspace init <dir>`: a standalone automations workspace with AGENTS.md, README.md,
 * `automations/`, a toolkit update script and the packaged swizzle-builder skill.
 */
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import {
  localCommand,
  type RunHandler,
  showsSubcommands,
  withExamples,
} from "./command-support.js";
import { AgentError, type CliIO, EXIT_CODES, respond } from "./output.js";
import { installSwizzleSkill } from "./skill-command.js";

interface WorkspaceInitResult {
  readonly automationsDirectory: string;
  readonly createdFiles: readonly string[];
  readonly skillTarget: string;
  readonly workspace: string;
}

export function registerWorkspaceCommand(
  program: Command,
  io: CliIO,
  runHandler: RunHandler,
): void {
  const workspace = localCommand(
    program.command("workspace").description("Create a standalone Swizzle automations workspace"),
  );
  showsSubcommands(workspace);
  withExamples(workspace, ["swizzle workspace init ./automations", "swizzle workspace init ."]);

  const init = localCommand(
    workspace
      .command("init")
      .description("Create a workspace with AGENTS.md, automations/ and the swizzle-builder skill")
      .argument("<dir>", "Workspace directory: new, empty, or replaced with --force")
      .option("--force", "Delete a non-empty directory's contents first"),
  );
  withExamples(init, [
    "swizzle workspace init ./automations",
    "swizzle workspace init ./automations --force --json",
  ]);
  init.action(async (targetDirectory: string, options: { readonly force?: boolean }) => {
    await runHandler(async () => {
      const result = await createAutomationWorkspace({
        force: options.force === true,
        targetDirectory,
      });
      respond(
        io,
        {
          workspace: {
            directory: result.workspace,
            automations: result.automationsDirectory,
            skill: result.skillTarget,
            files: result.createdFiles,
          },
        },
        [
          `Fill in the placeholders in ${path.join(result.workspace, "AGENTS.md")}`,
          "Run `swizzle profile add <name> --url <instance-url> --token-env SWIZZLE_TOKEN --env <environment>` to target an instance",
          `Run \`swizzle init ${path.join(targetDirectory, "automations/hello")} -t python\` to scaffold an automation`,
        ],
      );
    });
  });
}

async function createAutomationWorkspace(input: {
  readonly force: boolean;
  readonly targetDirectory: string;
}): Promise<WorkspaceInitResult> {
  const workspace = path.resolve(input.targetDirectory);
  await prepareWorkspaceTarget(workspace, input.force);

  const createdFiles: string[] = [];
  await mkdir(path.join(workspace, "automations"), { recursive: true });
  createdFiles.push("automations/");
  await mkdir(path.join(workspace, "scripts"), { recursive: true });

  await writeWorkspaceFile(workspace, "AGENTS.md", buildAgentsTemplate());
  createdFiles.push("AGENTS.md");
  await writeWorkspaceFile(workspace, "README.md", buildReadmeTemplate());
  createdFiles.push("README.md");
  await writeWorkspaceFile(workspace, ".gitignore", buildGitignoreTemplate());
  createdFiles.push(".gitignore");
  await writeWorkspaceFile(workspace, "scripts/update-toolkit.sh", buildUpdateToolkitScript());
  await chmod(path.join(workspace, "scripts/update-toolkit.sh"), 0o755);
  createdFiles.push("scripts/update-toolkit.sh");

  const skill = await installSwizzleSkill({
    force: true,
    workspaceDirectory: workspace,
  });
  createdFiles.push(".agents/skills/swizzle-builder/");
  if (skill.claudeSkills.action === "created" || skill.claudeSkills.action === "existing") {
    createdFiles.push(".claude/skills");
  }

  return {
    automationsDirectory: path.join(workspace, "automations"),
    createdFiles,
    skillTarget: skill.target,
    workspace,
  };
}

async function prepareWorkspaceTarget(workspace: string, force: boolean): Promise<void> {
  const existing = await stat(workspace).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  if (existing === undefined) {
    await mkdir(workspace, { recursive: true });
    return;
  }

  if (!existing.isDirectory()) {
    throw new AgentError({
      code: "WORKSPACE_TARGET_NOT_DIRECTORY",
      message: `Workspace target exists and is not a directory: ${workspace}`,
      hint: "Choose a directory path for the workspace.",
      exitCode: EXIT_CODES.conflict,
    });
  }

  const entries = await readdir(workspace);
  if (entries.length === 0) {
    return;
  }
  if (!force) {
    throw new AgentError({
      code: "WORKSPACE_NOT_EMPTY",
      message: `Workspace target already exists and is not empty: ${workspace}`,
      hint: "Name a new folder instead, such as: swizzle workspace init ./my-automations. --force deletes everything in the target first; never use it on a folder that holds other work.",
      exitCode: EXIT_CODES.conflict,
    });
  }

  await rm(workspace, { force: true, recursive: true });
  await mkdir(workspace, { recursive: true });
}

async function writeWorkspaceFile(
  workspace: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFile(path.join(workspace, relativePath), content, "utf8");
}

function buildAgentsTemplate(): string {
  return `# Swizzle Workspace

This workspace contains deployable Swizzle automation folders.

## Fill These In

- Instance URL: <INSTANCE_URL>
- CLI profile name: <PROFILE_NAME>
- Environment name: <ENVIRONMENT_NAME>
- Public webhook base: <WEBHOOK_BASE_URL>

## Rules

- Keep automation code under \`automations/\`.
- Each automation folder needs its own \`config.yaml\`, entrypoint, and sample payload.
- Successful runs must write valid JSON to stdout. Logs go to stderr.
- Declare required secrets in \`config.yaml\`; do not commit plaintext secrets.
- Use \`swizzle validate <dir>\` and \`swizzle run <dir>\` before deploying.
- Deploy with an explicit profile and environment once the placeholders above are filled in.
`;
}

function buildReadmeTemplate(): string {
  return `# Swizzle Automations

Standalone Swizzle automation workspace.

## Setup

\`\`\`bash
swizzle profile add <name> --url <INSTANCE_URL>
# Create a device token in Settings > Agent access, then:
swizzle profile add <name> --url <INSTANCE_URL> --token-env SWIZZLE_TOKEN --env <ENVIRONMENT_NAME>
swizzle init automations/hello --template python
\`\`\`

Then edit \`automations/hello/config.yaml\`, run locally, and deploy to your instance.
`;
}

function buildGitignoreTemplate(): string {
  return `.env
.DS_Store
node_modules/
__pycache__/
.pytest_cache/
dist/
.swizzle/
`;
}

function buildUpdateToolkitScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

swizzle skill install --dir "$WORKSPACE_ROOT" --force
`;
}
