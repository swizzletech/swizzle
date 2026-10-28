// `just upgrade [vX.Y.Z]`: self-contained so an older checkout can run the target's script
// from its git directory before it has the recipe. Requires only the pinned Node and just.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

interface Release {
  readonly tag: string;
  readonly commit: string;
  readonly version: string;
}

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:rc\.(?:0|[1-9]\d*)))?$/u;
const compose = ["compose", "--env-file", ".env", "-f", "infra/docker/compose.yml"];

function capture(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "inherit" });
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveRelease(requestedTag: string | undefined): Release {
  if (requestedTag !== undefined && !TAG.test(requestedTag)) {
    throw new Error(
      "Use a release tag such as v1.0.3 or v2.0.0-rc.1, or omit it for the newest stable release.",
    );
  }
  const tags = capture("git", [
    "ls-remote",
    "--tags",
    "--refs",
    "--sort=-version:refname",
    "origin",
  ])
    .split("\n")
    .map((line) => line.split("\t")[1]?.replace(/^refs\/tags\//u, "") ?? "")
    .filter((name) => TAG.test(name));
  const tag = requestedTag ?? tags.find((name) => !name.includes("-"));
  if (tag === undefined) throw new Error("No stable release tags found on origin.");
  if (!tags.includes(tag)) throw new Error(`Release tag ${tag} was not found on origin.`);
  run("git", ["fetch", "--no-tags", "origin", `refs/tags/${tag}`]);
  const commit = capture("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  const manifest: unknown = JSON.parse(capture("git", ["show", `${commit}:package.json`]));
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    !TAG.test(`v${manifest.version}`)
  ) {
    throw new Error(`Release ${tag} has no valid package.json version.`);
  }
  return { tag, commit, version: manifest.version };
}

async function upgrade(requestedTag: string | undefined): Promise<void> {
  // This guard precedes even fetching tags and creating the backup directory.
  if (capture("git", ["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error(
      "Checkout has uncommitted changes. Commit or remove them before running just upgrade.",
    );
  }
  await readFile(".env");
  const release = resolveRelease(requestedTag);
  const previous = capture("git", ["rev-parse", "HEAD"]);
  const directory = path.join(
    capture("git", ["rev-parse", "--path-format=absolute", "--git-path", "swizzle-upgrades"]),
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const backup = path.join(directory, "backup");
  const envBackup = path.join(directory, "env");
  await copyFile(".env", envBackup);
  await chmod(envBackup, 0o600);
  const restore = `git checkout --detach ${previous} && cp ${quote(envBackup)} .env && docker compose --env-file .env -f infra/docker/compose.yml --profile stack build && just restore ${quote(backup)}`;
  process.stdout.write(
    `Upgrading ${previous} to ${release.tag} (${release.commit}).\nBackup directory: ${directory}\n`,
  );
  try {
    // Drain all writers before exporting the database and artifacts together.
    run("docker", [...compose, "--profile", "stack", "stop", "api", "scheduler", "worker"]);
    run("just", ["backup", backup]);
  } catch (error) {
    process.stdout.write(
      `Backup did not complete. Checkout is still ${previous}.\nRestart it with: just stack\nBackup directory: ${directory}\n`,
    );
    throw error;
  }
  process.stdout.write(`Backup complete: ${backup}\nRestore with: ${restore}\n`);
  try {
    run("git", ["checkout", "--detach", release.commit]);
    run("just", ["stack"]);
    // Probe the running process inside its container, independent of public DNS or TLS.
    run("docker", [
      ...compose,
      "exec",
      "-T",
      "api",
      "node",
      "--input-type=module",
      "-e",
      `
      const expected = ${JSON.stringify(release.version)};
      const deadline = Date.now() + 180000;
      let observed = 'no response';
      for (;;) {
        try {
          const response = await fetch('http://127.0.0.1:19820/health', { signal: AbortSignal.timeout(5000) });
          const health = await response.json();
          observed = JSON.stringify(health);
          if (response.ok && health.status === 'ok' && health.version === expected) {
            console.log('/health reports ' + expected);
            break;
          }
        } catch (error) { observed = String(error); }
        if (Date.now() >= deadline) throw new Error('Expected /health version ' + expected + '; saw ' + observed);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    `,
    ]);
  } catch (error) {
    process.stdout.write(`Upgrade failed. Backup: ${backup}\nRestore with: ${restore}\n`);
    throw error;
  }
  process.stdout.write(
    `Upgraded ${previous} to ${release.tag} (${release.commit}); /health reports ${release.version}.\nBackup: ${backup}\n`,
  );
}

try {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("Usage: just upgrade [vX.Y.Z]");
  await upgrade(args[0] === "" ? undefined : args[0]);
} catch (error) {
  process.stderr.write(
    `Upgrade stopped: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
