// `just upgrade [vX.Y.Z]`: self-contained so an older checkout can run the target's script
// and stack-images.ts from its git directory before it has the recipe.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  capture,
  composeArgs,
  preflight,
  prepareImages,
  RELEASE_TAG,
  readCompose,
  run,
  writeCompose,
} from "./stack-images.ts";

interface Release {
  readonly tag: string;
  readonly commit: string;
  readonly version: string;
}
const compose = ["compose", "--env-file", ".env", "-f", "infra/docker/compose.yml"];

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveRelease(requestedTag: string | undefined): Release {
  if (requestedTag !== undefined && !RELEASE_TAG.test(requestedTag)) {
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
    .filter((name) => RELEASE_TAG.test(name));
  const tag = requestedTag ?? tags.find((name) => !name.includes("-"));
  if (tag === undefined) throw new Error("No stable release tags found on origin.");
  if (!tags.includes(tag)) throw new Error(`Release tag ${tag} was not found on origin.`);
  run("git", ["fetch", "--no-tags", "origin", `refs/tags/${tag}:refs/swizzle/releases/${tag}`]);
  const commit = capture("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  const manifest: unknown = JSON.parse(capture("git", ["show", `${commit}:package.json`]));
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    !RELEASE_TAG.test(`v${manifest.version}`)
  ) {
    throw new Error(`Release ${tag} has no valid package.json version.`);
  }
  if (`v${manifest.version}` !== tag)
    throw new Error(`Tag ${tag} does not match package version ${manifest.version}.`);
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
  const source = { root: process.cwd(), envFile: path.resolve(".env") };
  preflight(source);
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
  const targetRoot = path.join(directory, "target");
  await mkdir(targetRoot);
  const archive = execFileSync("git", ["archive", release.commit], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", targetRoot], { input: archive });
  const target = {
    root: targetRoot,
    envFile: path.join(targetRoot, ".env"),
    version: release.version,
  };
  // Trust the selected release's pinned toolchain before the installed services are touched.
  run("mise", ["trust"], targetRoot);
  preflight(target);
  await copyFile(source.envFile, target.envFile);
  run("mise", ["exec", "--", "node", "scripts/init-env.ts"], targetRoot);
  const prepared = prepareImages(target, path.join(directory, "target.json"));
  // Backup format 1 is schema-agnostic: use the prepared tool before applying migrations.
  const currentBackupImage = prepared.images.backup;
  if (currentBackupImage === undefined) throw new Error("The release has no backup image.");
  const rollback = readCompose(source);
  for (const [name, service] of Object.entries(rollback.services)) {
    const containers = capture("docker", [...composeArgs(source), "ps", "--all", "--quiet", name])
      .split("\n")
      .filter(Boolean);
    service.image =
      name === "backup"
        ? currentBackupImage
        : containers.length > 0
          ? capture("docker", ["inspect", "--format", "{{.Image}}", ...containers])
          : capture("docker", [
              "image",
              "inspect",
              "--format",
              "{{.Id}}",
              service.image ?? `${rollback.name}-${name}`,
            ]);
    const [image, ...otherImages] = new Set(service.image.split("\n").filter(Boolean));
    if (image === undefined || otherImages.length > 0) {
      throw new Error(
        `Service ${name} has containers with different images or no image. Reconcile its containers before retrying.`,
      );
    }
    service.image = image;
    delete service.build;
    service.pull_policy = "never";
  }
  if (
    rollback.services.worker?.environment !== undefined &&
    rollback.services["runner-base"]?.image !== undefined
  ) {
    rollback.services.worker.environment.SWIZZLE_RUNNER_BASE_IMAGE =
      rollback.services["runner-base"].image;
  }
  const rollbackFile = path.join(directory, "rollback.json");
  writeCompose(rollback, rollbackFile);
  const oldCompose = `docker compose -f ${quote(rollbackFile)}`;
  const restore = `git checkout --detach ${previous} && cp ${quote(envBackup)} .env && ${oldCompose} --profile stack stop api scheduler worker && tar -C ${quote(backup)} -cf - . | ${oldCompose} --profile tools run --pull never --rm -T --volume /backup --entrypoint sh backup -ec 'tar -xf - -C /backup; exec node dist/bin.js backup restore --input-dir /backup --yes' && ${oldCompose} --profile stack up --no-build --pull never -d --wait`;
  process.stdout.write(
    `Upgrading ${previous} to ${release.tag} (${release.commit}).\nBackup directory: ${directory}\n`,
  );
  try {
    // Drain all writers before exporting the database and artifacts together.
    run("docker", [...compose, "--profile", "stack", "stop", "api", "scheduler", "worker"]);
    const recipes = await readFile("justfile", "utf8");
    if (recipes.includes("_backup dir config:")) run("just", ["_backup", backup, rollbackFile]);
    else run("just", ["--set", "compose", oldCompose, "backup", backup]);
  } catch (error) {
    process.stdout.write(
      `Backup did not complete. Checkout is still ${previous}.\nRestart it with: ${oldCompose} --profile stack up --no-build --pull never -d --wait\nBackup directory: ${directory}\n`,
    );
    throw error;
  }
  process.stdout.write(`Backup complete: ${backup}\nRestore with: ${restore}\n`);
  try {
    run("git", ["checkout", "--detach", release.commit]);
    // Move configuration forward with the target release before migrations start.
    await copyFile(target.envFile, source.envFile);
    await chmod(source.envFile, 0o600);
    run("docker", [
      "compose",
      "-f",
      prepared.file,
      "--profile",
      "stack",
      "up",
      "--no-build",
      "--pull",
      "never",
      "-d",
      "--wait",
    ]);
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
