import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { diskSpace } from "../test/disk-space.js";
import { temporaryDirectory } from "../test/support.js";

const execute = promisify(execFile);

// Every file below a directory with its mode and contents, and every directory with its mode.
async function snapshot(directory: string) {
  const entries: Record<string, string> = {};
  for (const name of (await readdir(directory, { recursive: true })).sort()) {
    const info = await stat(path.join(directory, name));
    const mode = (info.mode & 0o777).toString(8);
    entries[name] = info.isFile()
      ? `${mode} ${await readFile(path.join(directory, name), "utf8")}`
      : mode;
  }
  return entries;
}

it.each(
  ["complete", "truncated", "existing destination", "low disk"].flatMap((scenario) =>
    ["absolute", "mise"].map((invocation) => ({ scenario, invocation })),
  ),
)(
  "publishes only a complete backup into a new directory ($scenario, $invocation)",
  async ({ scenario, invocation }) => {
    diskSpace(64);
    const root = await temporaryDirectory("swizzle-backup-recipe-");
    const checkout = path.join(root, "checkout");
    await mkdir(path.join(checkout, "scripts"), { recursive: true });
    await mkdir(path.join(checkout, "packages/runtime/src"), { recursive: true });
    for (const file of [
      "justfile",
      "mise.toml",
      "scripts/stack.ts",
      "scripts/stack-images.ts",
      "packages/runtime/src/backup.ts",
    ]) {
      await copyFile(new URL(`../${file}`, import.meta.url), path.join(checkout, file));
    }
    await writeFile(path.join(checkout, "package.json"), '{"type":"module","version":"1.0.3"}');
    await writeFile(
      path.join(checkout, "Dockerfile"),
      "FROM alpine:3.24.3\nRUN pnpm exec turbo run build\n",
    );
    await execute("git", ["init", "--initial-branch=fixture", checkout]);
    await execute("git", ["-C", checkout, "add", "."]);
    await execute("git", [
      "-C",
      checkout,
      "-c",
      "user.name=Backup test",
      "-c",
      "user.email=test@swizzle.test",
      "commit",
      "-m",
      "Fixture",
    ]);
    const source = path.join(root, "source");
    // A space in the directory must survive into the printed restore command.
    const output = path.join(root, "daily backup");
    const bin = path.join(root, "bin");
    const dockerLog = path.join(root, "docker.log");
    const backup = {
      "database.sql": "new dump".repeat(1000),
      "metadata.json": JSON.stringify({
        artifactBackend: "local",
        createdAt: "2026-10-24T00:00:00.000Z",
        formatVersion: 1,
      }),
      "artifacts/main.js": "new code",
    };
    await mkdir(path.join(source, "artifacts"), { recursive: true });
    await mkdir(bin);
    for (const [name, contents] of Object.entries(backup))
      await writeFile(path.join(source, name), contents, { mode: 0o644 });
    const archive = path.join(root, "backup.tar");
    await execute("tar", [
      "-cf",
      archive,
      "-C",
      source,
      "database.sql",
      "artifacts",
      "metadata.json",
    ]);
    if (scenario === "truncated")
      await writeFile(archive, (await readFile(archive)).subarray(0, 700));
    if (scenario === "existing destination") {
      await mkdir(output);
      await writeFile(path.join(output, "metadata.json"), "previous backup");
    }
    // A shell script, not Node: Node reads the recipe's `--env-file .env` argument as its own
    // option and exits when the checkout has no .env.
    await writeFile(
      path.join(bin, "docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_DOCKER_LOG"
case " $* " in
  *" build "*)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --iidfile ]; then printf '%s\\n' sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$2"; break; fi
      shift
    done ;;
  *" info "*) echo /tmp ;;
  *" config "*) printf '%s\\n' "$FIXTURE_COMPOSE_CONFIG" ;;
  *" inspect "*) echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  *" run "*) cat "$FIXTURE_BACKUP_ARCHIVE" ;;
esac
`,
      { mode: 0o755 },
    );
    const locate = async (command: string) =>
      (await execute("bash", ["-c", 'command -v "$1"', "fixture", command])).stdout.trim();
    const just = await locate("just");
    // Keep every required tool even when the host installs it beside just.
    for (const command of [
      "mise",
      "git",
      "bash",
      "tar",
      "cp",
      "mkdir",
      "dirname",
      "basename",
      "mktemp",
      "rm",
      "cat",
    ]) {
      await symlink(await locate(command), path.join(bin, command));
    }
    vi.stubEnv("FIXTURE_DOCKER_LOG", dockerLog);
    vi.stubEnv("FIXTURE_BACKUP_ARCHIVE", archive);
    vi.stubEnv(
      "FIXTURE_COMPOSE_CONFIG",
      JSON.stringify({
        name: "backup-test",
        services: {
          backup: { build: { context: checkout, dockerfile: "Dockerfile", target: "cli" } },
        },
      }),
    );
    vi.stubEnv("PATH", bin);
    // The runner has no globally selected tools to mask a missing fixture toolchain.
    vi.stubEnv("MISE_GLOBAL_CONFIG_FILE", path.join(root, "global.toml"));
    vi.stubEnv("MISE_TRUSTED_CONFIG_PATHS", checkout);

    if (scenario === "low disk") diskSpace(8);

    const result =
      invocation === "mise"
        ? execute("mise", ["x", "--", "just", "backup", output], { cwd: checkout })
        : execute(just, ["backup", output], { cwd: checkout });
    if (scenario === "low disk") {
      await expect(result).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Need at least 12 GiB free at /tmp for source builds and backup",
        ),
      });
      expect(await readdir(root)).not.toContain("daily backup");
      expect(await readFile(dockerLog, "utf8")).not.toContain(" build ");
    }
    if (scenario === "complete") {
      // The export inside the container names its own path, which the host cannot restore from.
      expect((await result).stdout).toBe(
        `Backup written to ${output}. Run \`just restore '${output}'\` to restore it.\n`,
      );
      expect(await snapshot(output)).toEqual({
        artifacts: "700",
        "artifacts/main.js": "600 new code",
        "database.sql": `600 ${backup["database.sql"]}`,
        "metadata.json": `600 ${backup["metadata.json"]}`,
      });
      expect((await stat(output)).mode & 0o777).toBe(0o700);
    }
    if (scenario === "truncated") {
      await expect(result).rejects.toMatchObject({ stderr: expect.stringContaining("tar:") });
      expect(await readdir(root)).not.toContain("daily backup");
    }
    if (scenario === "existing destination") {
      await expect(result).rejects.toMatchObject({
        stderr: expect.stringContaining("Choose a new directory, for example one named by date"),
      });
      expect(await readFile(dockerLog, "utf8").catch(() => "")).toBe("");
      expect(await snapshot(output)).toEqual({ "metadata.json": "644 previous backup" });
    }
    expect((await readdir(root)).filter((name) => name.startsWith("."))).toEqual([]);
  },
);
