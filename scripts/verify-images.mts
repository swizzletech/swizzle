// `just verify-images <evidence>` exercises install, upgrade, rollback and refusal on one packaged
// stack and a private OCI registry. All resources belong to this invocation and are removed.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { ensureEnvFile, packagedStackValues } from "./env-file.ts";

const execute = promisify(execFile);
const evidence = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Pass an evidence directory.");
await mkdir(evidence, { recursive: true });
const source = process.cwd();
const gitDirectory = execFileSync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-path", "swizzle-image-proof"],
  { encoding: "utf8" },
).trim();
await mkdir(gitDirectory, { recursive: true });
const directory = await mkdtemp(path.join(gitDirectory, "run-"));
const exported = path.join(directory, "public");
const checkout = path.join(directory, "installed");
const bin = path.join(directory, "bin");
const trace = path.join(directory, "docker.jsonl");
const project = `swizzle-images-${randomBytes(4).toString("hex")}`;
const registry = `${project}-registry`;
const realDocker = execFileSync("bash", ["-c", "command -v docker"], { encoding: "utf8" }).trim();
const realJust = execFileSync("bash", ["-c", "command -v just"], { encoding: "utf8" }).trim();
const realMise = execFileSync("bash", ["-c", "command -v mise"], { encoding: "utf8" }).trim();
const env: NodeJS.ProcessEnv = { ...process.env };
let installed = false;
let published: string[] = [];
let publicationRevision = "";
let registryVolumes: string[] = [];

async function command(
  program: string,
  args: string[],
  cwd = checkout,
  extra: NodeJS.ProcessEnv = {},
) {
  const result = await execute(program, args, {
    cwd,
    env: { ...env, ...extra },
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout + result.stderr;
}
async function record(
  name: string,
  program: string,
  args: string[],
  cwd = checkout,
  extra: NodeJS.ProcessEnv = {},
) {
  process.stdout.write(`image-proof: ${name}\n`);
  try {
    const output = await command(program, args, cwd, extra);
    await writeFile(
      path.join(evidence, `${name}.txt`),
      `$ ${program} ${args.join(" ")}\n${output}`,
    );
    return output;
  } catch (error) {
    await writeFile(path.join(evidence, `${name}.txt`), String(error));
    throw error;
  }
}
const compose = (...args: string[]) =>
  command("docker", [
    "compose",
    "--env-file",
    ".env",
    "-f",
    "infra/docker/compose.yml",
    "--profile",
    "stack",
    ...args,
  ]);
async function events() {
  return (await readFile(trace, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line): { args: string[]; writers?: boolean } => JSON.parse(line));
}
async function healthy(name: string) {
  const output = await record(name, "docker", [
    "compose",
    "--env-file",
    ".env",
    "-f",
    "infra/docker/compose.yml",
    "--profile",
    "stack",
    "ps",
    "--all",
    "--format",
    "json",
  ]);
  const rows: { Service: string; State: string; Health: string; ExitCode: number }[] = output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 13);
  for (const row of rows) {
    if (["migrate", "runner-base"].includes(row.Service)) assert.equal(row.ExitCode, 0);
    else {
      assert.equal(row.State, "running", row.Service);
      assert.equal(row.Health, "healthy", row.Service);
    }
  }
  const probe = await compose(
    "exec",
    "-T",
    "valkey",
    "sh",
    "-ec",
    'valkey-cli --no-auth-warning -a "$VALKEY_PASSWORD" ping',
  );
  assert.equal(probe.trim(), "PONG");
  const container = (await compose("ps", "--quiet", "valkey")).trim();
  const health: unknown = JSON.parse(
    await command(realDocker, ["inspect", "--format", "{{json .State.Health.Log}}", container]),
  );
  assert.ok(Array.isArray(health) && health.length > 0);
  const latest: unknown = health.at(-1);
  assert.ok(
    latest !== null &&
      typeof latest === "object" &&
      "Output" in latest &&
      typeof latest.Output === "string",
  );
  assert.equal(latest.Output.trim(), "PONG");
  await writeFile(path.join(evidence, `${name}-valkey-probe.txt`), JSON.stringify(health, null, 2));
}
async function sql(statement: string) {
  return compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "swizzle",
    "-d",
    "swizzle",
    "-Atc",
    statement,
  );
}
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const selected = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return selected;
}
try {
  await record("export", "just", ["export-public", exported], source);
  await command("git", ["checkout", "-b", "proof-release"], exported);
  await command(
    "git",
    [
      "-c",
      "user.name=Image proof",
      "-c",
      "user.email=proof@swizzle.test",
      "commit",
      "-m",
      "Local public image proof",
    ],
    exported,
  );
  publicationRevision = (await command("git", ["rev-parse", "HEAD"], exported)).trim();
  await command("mise", ["trust"], exported);
  const manifest: { version: string } = JSON.parse(
    await readFile(path.join(exported, "package.json"), "utf8"),
  );
  const version = manifest.version;
  await command("git", ["tag", `v${version}`], exported);
  await command(
    realDocker,
    ["run", "--detach", "--name", registry, "--publish", "127.0.0.1::5000", "registry:3"],
    source,
  );
  const mounts: { Type: string; Name: string }[] = JSON.parse(
    await command(realDocker, ["inspect", "--format", "{{json .Mounts}}", registry], source),
  );
  registryVolumes = mounts.filter((mount) => mount.Type === "volume").map((mount) => mount.Name);
  const binding = (await command(realDocker, ["port", registry, "5000/tcp"], source)).trim();
  const namespace = `${binding}/swizzletech`;
  const plan = path.join(directory, "images.json");
  await record("image-plan-ghcr", "just", ["image-plan", version, plan], exported, {
    SWIZZLE_IMAGE_REGISTRY: "ghcr.io/swizzletech",
  });
  await record(
    "bake-dry-run-ghcr",
    realDocker,
    ["buildx", "bake", "-f", plan, "--print"],
    exported,
  );
  env.SWIZZLE_IMAGE_REGISTRY = namespace;
  await record("image-plan", "just", ["image-plan", version, plan], exported);
  await record("bake-dry-run", realDocker, ["buildx", "bake", "-f", plan, "--print"], exported);
  const bake: { target: Record<string, { tags: string[]; platforms: string[] }> } = JSON.parse(
    await readFile(plan, "utf8"),
  );
  published = Object.values(bake.target).flatMap((target) => target.tags);
  assert.equal(published.length, 12);
  assert.ok(
    Object.values(bake.target).every(
      (target) => target.platforms.join(",") === "linux/amd64,linux/arm64",
    ),
  );
  await record(
    "publish-native",
    realDocker,
    ["buildx", "bake", "-f", plan, "--set", "*.platform=linux/amd64", "--push"],
    exported,
  );
  await command(
    "git",
    ["clone", "--shared", "--branch", `v${version}`, exported, checkout],
    source,
  );
  await command("mise", ["trust"], checkout);
  const http = await port();
  let https = await port();
  while (https === http) https = await port();
  let links = await port();
  while ([http, https].includes(links)) links = await port();
  await ensureEnvFile(
    path.join(checkout, ".env"),
    await readFile(path.join(checkout, ".env.example"), "utf8"),
    {
      ...packagedStackValues(project),
      SWIZZLE_HTTP_PORT: String(http),
      SWIZZLE_HTTPS_PORT: String(https),
      SWIZZLE_LINK_PORT: String(links),
      SWIZZLE_DASHBOARD_ORIGIN: `http://localhost:${http}`,
      SWIZZLE_API_ORIGIN: `http://api.localhost:${http}`,
    },
  );
  await mkdir(bin);
  await writeFile(
    path.join(bin, "docker"),
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (process.env.PROOF_LOW_DISK && args[0] === 'info' && args.includes('{{.DockerRootDir}}')) { console.log('/proc'); process.exit(0); }
let writers;
if (process.env.PROOF_WRITERS && args[0] === 'pull') {
  const ids = process.env.PROOF_WRITERS.split(',');
  const result = spawnSync(${JSON.stringify(realDocker)}, ['inspect', '--format', '{{.State.Running}}', ...ids], {encoding:'utf8'});
  writers = result.status === 0 && result.stdout.trim().split('\\n').every(value => value === 'true');
  if (!writers) process.exit(91);
}
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args,writers})+'\\n');
if (process.env.PROOF_NO_BUILD && args.includes('build')) process.exit(92);
const result = spawnSync(${JSON.stringify(realDocker)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  installed = true;
  await record("release-stack", "just", ["stack"], checkout, { PROOF_NO_BUILD: "1" });
  assert.equal((await events()).filter((event) => event.args.includes("build")).length, 0);
  await writeFile(
    path.join(evidence, "release-events.json"),
    JSON.stringify(await events(), null, 2),
  );
  await healthy("release-health");
  await sql(
    "CREATE TABLE image_upgrade_probe (value text); INSERT INTO image_upgrade_probe VALUES ('before');",
  );
  const publicBackup = path.join(directory, "operator-backup");
  await record("operator-backup", "just", ["backup", publicBackup], checkout, {
    PROOF_NO_BUILD: "1",
  });
  await sql("UPDATE image_upgrade_probe SET value = 'after-operator-backup';");
  await record("operator-restore", "just", ["--yes", "restore", publicBackup], checkout, {
    PROOF_NO_BUILD: "1",
  });
  assert.match(await sql("SELECT value FROM image_upgrade_probe"), /before/u);
  await healthy("operator-restored-health");

  await writeFile(path.join(checkout, "proof-installed"), "Installed checkout before upgrade\n");
  await command("git", ["add", "proof-installed"]);
  await command("git", [
    "-c",
    "user.name=Image proof",
    "-c",
    "user.email=proof@swizzle.test",
    "commit",
    "-m",
    "Local installed state",
  ]);
  const previous = (await command("git", ["rev-parse", "HEAD"])).trim();
  await command("git", ["tag", "--force", `v${version}`]);
  const writers = (await compose("ps", "--quiet", "api", "scheduler", "worker"))
    .trim()
    .split("\n")
    .join(",");
  await writeFile(trace, "");
  const upgraded = await record("pull-upgrade", "just", ["upgrade", `v${version}`], checkout, {
    PROOF_WRITERS: writers,
    PROOF_NO_BUILD: "1",
  });
  const pulled = await events();
  await writeFile(path.join(evidence, "pull-events.json"), JSON.stringify(pulled, null, 2));
  const stopped = pulled.findIndex((event) => event.args.includes("stop"));
  assert.ok(stopped > 0);
  assert.ok(
    pulled.filter((event) => event.args[0] === "pull").every((event) => event.writers === true),
  );
  assert.ok(
    pulled
      .slice(stopped)
      .every((event) => event.args[0] !== "pull" && !event.args.includes("build")),
  );
  await healthy("upgraded-health");
  assert.match(await sql("SELECT value FROM image_upgrade_probe"), /before/u);
  await sql("UPDATE image_upgrade_probe SET value = 'after';");
  const restore = /^Restore with: (.+)$/mu.exec(upgraded)?.[1];
  assert.ok(restore);
  await record("restore-pulled", "bash", ["-euo", "pipefail", "-c", restore]);
  assert.equal((await command("git", ["rev-parse", "HEAD"])).trim(), previous);
  assert.match(await sql("SELECT value FROM image_upgrade_probe"), /before/u);
  await healthy("restored-health");
  const runningBefore = await compose("ps", "--quiet", "api", "scheduler", "worker");
  for (const missing of ["just", "mise", "docker compose"]) {
    const limited = path.join(directory, `missing-${missing.replace(" ", "-")}`);
    await mkdir(limited);
    for (const tool of [
      "git",
      "node",
      "just",
      "mise",
      "docker",
      "bash",
      "tar",
      "cp",
      "mkdir",
      "dirname",
      "basename",
      "mktemp",
      "rm",
    ]) {
      if (tool === missing) continue;
      const executable = execFileSync("bash", ["-c", 'command -v "$1"', "find-tool", tool], {
        encoding: "utf8",
      }).trim();
      if (missing === "docker compose" && tool === "docker")
        await writeFile(path.join(limited, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      else await symlink(executable, path.join(limited, tool));
    }
    let refusal = "";
    const invocation = [
      "--shell",
      "/bin/bash",
      "--clear-shell-args",
      "--shell-arg=-euo",
      "--shell-arg=pipefail",
      "--shell-arg=-c",
      "upgrade",
      `v${version}`,
    ];
    try {
      // Override the recipe shell so mise cannot repair the deliberately restricted PATH.
      await command(realJust, invocation, checkout, { PATH: limited });
    } catch (error) {
      refusal = String(error);
    }
    assert.match(refusal, new RegExp(`Missing or unusable ${missing}`));
    assert.equal(await compose("ps", "--quiet", "api", "scheduler", "worker"), runningBefore);
    await writeFile(
      path.join(evidence, `missing-${missing.replace(" ", "-")}.txt`),
      `$ ${realJust} ${invocation.join(" ")}\n${refusal}\nRunning writer IDs unchanged:\n${runningBefore}`,
    );
  }
  let sshRefusal = "";
  try {
    await command(realMise, ["exec", "--", "node", "scripts/upgrade.ts", `v${version}`], checkout, {
      PATH: path.join(directory, "missing-mise"),
    });
  } catch (error) {
    sshRefusal = String(error);
  }
  assert.match(sshRefusal, /Missing or unusable mise/u);
  assert.equal(await compose("ps", "--quiet", "api", "scheduler", "worker"), runningBefore);
  await writeFile(path.join(evidence, "mise-exec-without-mise-path.txt"), sshRefusal);
  let lowDisk = "";
  try {
    await command(process.execPath, ["scripts/upgrade.ts", `v${version}`], checkout, {
      PROOF_LOW_DISK: "1",
    });
  } catch (error) {
    lowDisk = String(error);
  }
  assert.match(lowDisk, /Need at least 5 GiB free/u);
  assert.equal(await compose("ps", "--quiet", "api", "scheduler", "worker"), runningBefore);
  await writeFile(path.join(evidence, "disk-refusal.txt"), lowDisk);
  await writeFile(trace, "");
  await record("fallback-upgrade", "just", ["upgrade", `v${version}`], checkout, {
    SWIZZLE_IMAGE_REGISTRY: `${binding}/absent`,
  });
  const fallback = await events();
  await writeFile(path.join(evidence, "fallback-events.json"), JSON.stringify(fallback, null, 2));
  const builds = fallback.filter((event) => event.args.includes("build"));
  assert.equal(builds.length, 12); // all twelve target images, including the backup tool
  assert.ok(
    builds.every(
      (event) =>
        event.args[0] === "buildx" &&
        event.args[1] === "build" &&
        event.args.filter((arg) => arg === "--tag").length === 1,
    ),
  );
  const stop = fallback.findIndex((event) => event.args.includes("stop"));
  assert.ok(fallback.slice(stop).every((event) => !event.args.includes("build")));
  await healthy("fallback-health");
  const fromBuilt = await record("upgrade-from-built", "just", ["upgrade", `v${version}`]);
  await sql("UPDATE image_upgrade_probe SET value = 'after-built';");
  const restoreBuilt = /^Restore with: (.+)$/mu.exec(fromBuilt)?.[1];
  assert.ok(restoreBuilt);
  await record("restore-built", "bash", ["-euo", "pipefail", "-c", restoreBuilt]);
  assert.match(await sql("SELECT value FROM image_upgrade_probe"), /before/u);
  await healthy("restored-built-health");
  await writeFile(trace, "");
  await record("custom-web-stack", "just", ["stack"], checkout, {
    SWIZZLE_WEB_API_BASE_URL: "/api/",
  });
  const customBuilds = (await events()).filter((event) => event.args.includes("build"));
  assert.equal(customBuilds.length, 1);
  assert.ok(customBuilds[0]?.args.includes("com.docker.compose.service=web"));
  await writeFile(
    path.join(evidence, "custom-web-events.json"),
    JSON.stringify(await events(), null, 2),
  );
  await healthy("custom-web-health");

  await writeFile(
    path.join(checkout, "proof-development"),
    "Development checkout without a release tag\n",
  );
  await command("git", ["add", "proof-development"]);
  await command("git", [
    "-c",
    "user.name=Image proof",
    "-c",
    "user.email=proof@swizzle.test",
    "commit",
    "-m",
    "Local development checkout",
  ]);
  await writeFile(trace, "");
  await record("development-stack", "just", ["stack"]);
  assert.equal((await events()).filter((event) => event.args.includes("build")).length, 12);
  await writeFile(
    path.join(evidence, "development-events.json"),
    JSON.stringify(await events(), null, 2),
  );
  await healthy("development-health");
  await writeFile(
    path.join(evidence, "result.txt"),
    "PASS: 12 public build targets, both architectures in dry run, local OCI publication, release install without builds, pull before shutdown, rollback data, missing-tool refusal, sequential fallback, development source builds.\n",
  );
} finally {
  if (installed)
    await record("cleanup-stack", "just", ["stack-down"], checkout, {
      PATH: process.env.PATH,
    }).catch((error) => process.stderr.write(String(error)));
  if (published.length > 0)
    await command(realDocker, ["image", "rm", ...published], source).catch(() => undefined);
  await command(realDocker, ["rm", "--force", "--volumes", registry], source).catch(
    () => undefined,
  );
  const resources: Record<string, string> = {};
  for (const resource of ["container", "network", "volume", "image"]) {
    const args =
      resource === "container"
        ? ["ps", "--all", "--quiet", "--filter", `name=${project}`]
        : [resource, "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`];
    resources[resource] = (await command(realDocker, args, source)).trim();
  }
  if (publicationRevision !== "")
    resources.registryImages = (
      await command(
        realDocker,
        [
          "image",
          "ls",
          "--all",
          "--quiet",
          "--filter",
          `label=org.opencontainers.image.revision=${publicationRevision}`,
        ],
        source,
      )
    ).trim();
  const remainingVolumes = (await command(realDocker, ["volume", "ls", "--quiet"], source)).split(
    "\n",
  );
  resources.registryVolumes = registryVolumes
    .filter((volume) => remainingVolumes.includes(volume))
    .join("\n");
  await writeFile(path.join(evidence, "cleanup.json"), JSON.stringify(resources, null, 2));
  await rm(directory, { recursive: true, force: true });
  assert.ok(
    Object.values(resources).every((value) => value === ""),
    "Verification left owned Docker resources; see cleanup.json.",
  );
}
