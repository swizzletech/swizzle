/**
 * `swizzle hooks install | status | remove`: registers the home view as a SessionStart hook in
 * Claude Code and Codex and as an ambient plugin in OpenCode (axi-sdk-js), so every agent session
 * starts with Swizzle's live state. Only this command writes agent config.
 */
import { type Command, Option } from "commander";

import {
  localCommand,
  type RunHandler,
  showsSubcommands,
  withExamples,
} from "./command-support.js";
import { AgentError, type CliIO, respond } from "./output.js";

const MARKER = "swizzle";

type Scope = "user" | "project";

interface ScopeOptions {
  readonly scope: Scope;
}

/** axi-sdk-js's root entry loads its update checker too, so it loads only when this runs. */
async function sdk() {
  return await import("axi-sdk-js");
}

function scopeOption(): Option {
  return new Option(
    "--scope <scope>",
    "user: each agent's home config; project: this directory's .claude, .codex and .opencode",
  )
    .choices(["user", "project"])
    .default("user");
}

function scopeTarget(options: ScopeOptions) {
  return {
    marker: MARKER,
    scope: options.scope,
    ...(options.scope === "project" ? { projectDir: process.cwd() } : {}),
  };
}

async function hookRows(options: ScopeOptions) {
  const status = (await sdk()).sessionStartHookStatus(scopeTarget(options));
  return [
    { agent: "claude-code", installed: status.claude.installed, path: status.claude.path },
    { agent: "codex", installed: status.codex.installed, path: status.codex.path },
    { agent: "opencode", installed: status.opencode.installed, path: status.opencode.path },
  ];
}

export function registerHooksCommand(program: Command, io: CliIO, runHandler: RunHandler): void {
  const hooks = localCommand(
    program
      .command("hooks")
      .description(
        "Start every Claude Code, Codex and OpenCode session with Swizzle's home view as context",
      ),
  );
  showsSubcommands(hooks);
  withExamples(hooks, ["swizzle hooks install", "swizzle hooks status --scope project"]);

  const install = localCommand(
    hooks
      .command("install")
      .description("Install or repair the session hooks; an unchanged install is a no-op")
      .addOption(scopeOption()),
  );
  withExamples(install, ["swizzle hooks install", "swizzle hooks install --scope project"]);
  install.action(async (options: ScopeOptions) => {
    await runHandler(async () => {
      const before = await hookRows(options);
      const errors: string[] = [];
      (await sdk()).installSessionStartHooks({
        ...scopeTarget(options),
        binaryNames: [MARKER],
        distEntrypoints: ["dist/bin.js"],
        onError: (message) => errors.push(message),
      });
      const after = await hookRows(options);
      if (errors.length > 0 || after.some((row) => !row.installed)) {
        throw new AgentError({
          code: "HOOKS_NOT_INSTALLED",
          details: { errors },
          hint: "Hooks point at an installed swizzle binary. Run this from `swizzle` on PATH, not from a source checkout.",
          message: `Could not install the session hooks for ${after
            .filter((row) => !row.installed)
            .map((row) => row.agent)
            .join(", ")}.`,
        });
      }
      respond(
        io,
        {
          scope: options.scope,
          state: before.every((row) => row.installed) ? "already installed (no-op)" : "installed",
          hooks: after,
        },
        ["A new agent session now starts with `swizzle`'s home view"],
      );
    });
  });

  const status = localCommand(
    hooks
      .command("status")
      .description("Show where the session hooks are installed")
      .addOption(scopeOption()),
  );
  withExamples(status, ["swizzle hooks status", "swizzle hooks status --scope project --json"]);
  status.action(async (options: ScopeOptions) => {
    await runHandler(async () => {
      const rows = await hookRows(options);
      respond(
        io,
        { scope: options.scope, hooks: rows },
        rows.every((row) => row.installed)
          ? []
          : [`Run \`swizzle hooks install --scope ${options.scope}\` to install them`],
      );
    });
  });

  const remove = localCommand(
    hooks
      .command("remove")
      .description("Remove the session hooks; other hooks stay; absent ones are a no-op")
      .addOption(scopeOption()),
  );
  withExamples(remove, ["swizzle hooks remove", "swizzle hooks remove --scope project"]);
  remove.action(async (options: ScopeOptions) => {
    await runHandler(async () => {
      const before = await hookRows(options);
      const errors: string[] = [];
      (await sdk()).uninstallSessionStartHooks({
        ...scopeTarget(options),
        onError: (message) => errors.push(message),
      });
      const after = await hookRows(options);
      if (errors.length > 0) {
        throw new AgentError({
          code: "HOOKS_NOT_REMOVED",
          details: { errors },
          hint: "Fix the named files' permissions, or edit them by hand.",
          message: "Could not remove every session hook.",
        });
      }
      respond(io, {
        scope: options.scope,
        state: before.some((row) => row.installed) ? "removed" : "already absent (no-op)",
        hooks: after,
      });
    });
  });
}
