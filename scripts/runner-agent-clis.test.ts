import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../test/support.js";

const script = resolve("scripts/runner-agent-clis.mts");

it("refreshes runner pins within their major while reporting a held major", async () => {
  const root = await temporaryDirectory("swizzle-agent-pins-");
  const bin = join(root, "bin");
  const docker = join(root, "infra/docker");
  await mkdir(bin);
  await mkdir(docker, { recursive: true });
  await writeFile(
    join(bin, "npm"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  "view @anthropic-ai/claude-code@latest version --json") echo \'["2.3.5"]\' ;;',
      '  "view @anthropic-ai/claude-code@2.x version --json") echo \'["2.3.4","2.3.5"]\' ;;',
      '  "view @openai/codex@latest version --json") echo \'["1.0.0"]\' ;;',
      '  "view @openai/codex@0.x version --json") echo \'["0.10.0","0.8.0","0.9.0"]\' ;;',
      '  "view @openai/codex@1.x version --json") echo \'"1.0.0"\' ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const file = join(docker, "Dockerfile");
  const stageBefore = "FROM node:26-alpine AS base\nRUN npm install --global pnpm@12.15.0\n";
  const runner = "FROM node:26-slim AS runner-base\nRUN npm install --global --no-audit \\\n";
  const stageAfter = "FROM base AS other\nRUN npm install --global @openai/codex@0.8.0\n";
  const original = `${stageBefore}${runner}  @anthropic-ai/claude-code@2.3.4 @openai/codex@0.8.0\n${stageAfter}`;
  const updated = `${stageBefore}${runner}  @anthropic-ai/claude-code@2.3.5 @openai/codex@0.10.0\n${stageAfter}`;
  await writeFile(file, original);

  const run = (mode: string) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [script, mode], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    return { status, stdout, stderr };
  };
  const claude = "Runner @anthropic-ai/claude-code 2.3.4 -> 2.3.5\n";
  expect(run("outdated")).toEqual({
    status: 1,
    stdout: `${claude}Runner @openai/codex 0.8.0 -> 1.0.0\n`,
    stderr: "",
  });
  expect(await readFile(file, "utf8")).toBe(original);
  expect(run("update")).toEqual({
    status: 0,
    stdout: `${claude}Runner @openai/codex 0.8.0 -> 0.10.0\n`,
    stderr: "",
  });
  expect(await readFile(file, "utf8")).toBe(updated);
  expect(run("update")).toEqual({ status: 0, stdout: "", stderr: "" });
  expect(run("outdated")).toEqual({
    status: 1,
    stdout: "Runner @openai/codex 0.10.0 -> 1.0.0\n",
    stderr: "",
  });
  expect(await readFile(file, "utf8")).toBe(updated);

  const ahead = updated.replace("@openai/codex@0.10.0", "@openai/codex@1.1.0");
  await writeFile(file, ahead);
  expect(run("outdated")).toEqual({ status: 0, stdout: "", stderr: "" });
  expect(run("update")).toEqual({ status: 0, stdout: "", stderr: "" });
  expect(await readFile(file, "utf8")).toBe(ahead);
});
