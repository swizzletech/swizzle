import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { temporaryDirectory } from "../test/support.js";
import { isPrivate } from "./private-paths.js";

const script = fileURLToPath(new URL("./export-public.mts", import.meta.url));

test("exports the selected commit without private files, dirty changes or source history", async () => {
  const root = await temporaryDirectory("swizzle-export-");
  const source = path.join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  const files = {
    "README.md": "Public documentation\n",
    "AGENTS.md": "private root guide",
    "CLAUDE.md": "@AGENTS.md",
    "nested/AGENTS.md": "private nested guide",
    "nested/CLAUDE.md": "@AGENTS.md",
    ".agents/checks/private.ts": "private checks",
    "nested/.agents/secret.md": "private nested skills",
    "CONTEXT.md": "private terms",
    "docs/adr/0019.md": "private decision",
    ".out-of-scope/declined.md": "private request",
    "apps/cli/assets/skills/swizzle-builder/SKILL.md": "Product skill\n",
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), text);
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "source",
  );
  const commit = git("rev-parse", "HEAD");
  await writeFile(path.join(source, "README.md"), "Dirty contents must not ship");
  await writeFile(path.join(source, "untracked.txt"), "Untracked contents must not ship");
  const destination = path.join(root, "public tree");
  const run = (target: string, ref: string) =>
    spawnSync(process.execPath, [script, target, ref], { cwd: source, encoding: "utf8" });
  const result = run(destination, commit);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe(
    "Public documentation\n",
  );
  const exported = execFileSync("git", ["-C", destination, "ls-files"], { encoding: "utf8" });
  expect(exported).toBe("README.md\napps/cli/assets/skills/swizzle-builder/SKILL.md\n");
  // The no-private-paths convention reads the same list, so it agrees with the archive.
  expect(Object.keys(files).filter((file) => !isPrivate(file))).toEqual(
    exported.trim().split("\n"),
  );
  for (const privatePath of [".agents", "nested/.agents", "docs/adr", ".out-of-scope"]) {
    expect(existsSync(path.join(destination, privatePath)), privatePath).toBe(false);
  }
  expect(spawnSync("git", ["-C", destination, "rev-parse", "--verify", "HEAD"]).status).toBe(128);
  expect(run(destination, commit).status).toBe(1);
  expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe(
    "Public documentation\n",
  );
  const invalid = path.join(root, "invalid");
  expect(run(invalid, "missing-ref").status).toBe(1);
  expect(existsSync(invalid)).toBe(false);
});
