import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../../test/support.js";

it("git commit requires public trailer lines to share the final trailer block", async () => {
  const cwd = await temporaryDirectory("swizzle-public-trailers-");
  await copyFile(new URL("../../lefthook.yml", import.meta.url), path.join(cwd, "lefthook.yml"));
  await mkdir(path.join(cwd, "scripts"));
  await symlink(import.meta.dirname, path.join(cwd, "scripts/conventions"), "dir");
  execFileSync("git", ["init", "--quiet"], { cwd });
  execFileSync("git", ["config", "core.hooksPath", ".git/hooks"], { cwd });
  execFileSync("lefthook", ["install", "--force"], { cwd });
  const commit = (message: string) =>
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Swizzle Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        message,
      ],
      { cwd, encoding: "utf8", env: { ...process.env, LEFTHOOK_EXCLUDE: "biome,secrets" } },
    );
  const title = "Public-Title: fix: preserve outputs";
  const change = "Public-Change: Preserve outputs from earlier runs.";
  const author = "Co-Authored-By: Contributor <contributor@example.com>";
  for (const [early, late] of [
    [title, change],
    [change, title],
  ]) {
    const rejected = commit(`fix: preserve outputs\n\n${early}\n\n${late}\n${author}`);
    expect.soft(rejected.status).toBe(1);
    expect.soft(rejected.stdout + rejected.stderr).toContain("final trailer block");
  }
  expect(commit(`fix: preserve outputs\n\n${title}\n${change}\n${author}`).status).toBe(0);
  expect(commit(`fix: preserve outputs\n\n${author}`).status).toBe(0);
});
