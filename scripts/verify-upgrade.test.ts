import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../test/support.js";

const execute = promisify(execFile);

it("starts the upgrade proof from the latest stable Git tag", async () => {
  const directory = await temporaryDirectory("swizzle-upgrade-selection-");
  const source = path.join(directory, "source");
  await mkdir(source);
  const git = async (...args: string[]) => execute("git", args, { cwd: source });
  await git("init", "--initial-branch=fixture");
  await git("config", "user.name", "Upgrade selection test");
  await git("config", "user.email", "test@swizzle.test");
  await copyFile(".env.example", path.join(source, ".env.example"));
  await git("add", ".");
  await git("commit", "-m", "Earlier stable release");
  await git("tag", "v1.9.9");
  await writeFile(path.join(source, "revision"), "latest stable\n");
  await git("add", ".");
  await git("commit", "-m", "Latest stable release");
  await git("tag", "--annotate", "v1.10.0", "--message", "Stable release");
  await git("tag", "v20.0.0-rc.1");
  await writeFile(path.join(source, "revision"), "upgrade target\n");
  await git("add", ".");
  await git("commit", "-m", "Upgrade target");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  // Stop at stack startup: selection and the release checkout use real Git, and this test
  // cannot start or remove a container belonging to another test on the shared daemon.
  await writeFile(
    path.join(bin, "docker"),
    `#!/bin/sh
case "$1 $2" in
  'info --format') echo 8 ;;
  'port '*) echo 127.0.0.1:1 ;;
  'compose '*) case " $* " in *' up '*) echo 'selection proof stops before stack startup' >&2; exit 1 ;; esac ;;
esac
`,
    { mode: 0o755 },
  );
  const result = await execute(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--conditions=swizzle-source",
      fileURLToPath(new URL("verify-upgrade.mts", import.meta.url)),
    ],
    {
      cwd: source,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        TMPDIR: directory,
      },
    },
  ).catch((error: { stdout: string; stderr: string }) => error);
  expect(result.stderr).toContain("selection proof stops before stack startup");
  expect(result.stdout).toContain("source v1.10.0;");
});
