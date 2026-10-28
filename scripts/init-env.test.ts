import { execFile, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../test/support.js";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// A checkout with the env template, and a `docker` on its PATH that answers `docker info` with
// the CPU count in FAKE_DOCKER_CPUS, so a test chooses the Docker host's size.
async function checkoutWithExampleEnv(): Promise<string> {
  const directory = await temporaryDirectory("swizzle-init-env-");
  await copyFile(path.join(repoRoot, ".env.example"), path.join(directory, ".env.example"));
  await mkdir(path.join(directory, "bin"));
  const docker = path.join(directory, "bin", "docker");
  await writeFile(docker, '#!/bin/sh\n[ "$1" = info ] && echo "$FAKE_DOCKER_CPUS"\n');
  await chmod(docker, 0o755);
  return directory;
}

// Runs the script as `just init-env` does: Node strips its types, so no loader starts with it.
const initEnvCommand = [process.execPath, [path.join(repoRoot, "scripts/init-env.ts")]] as const;

function dockerHost(cwd: string, cpus: number) {
  const PATH = `${path.join(cwd, "bin")}${path.delimiter}${process.env.PATH}`;
  return { ...process.env, PATH, FAKE_DOCKER_CPUS: String(cpus) };
}

function initEnv(cwd: string, cpus = 8, shell: Readonly<Record<string, string>> = {}) {
  return spawnSync(...initEnvCommand, {
    cwd,
    encoding: "utf8",
    env: { ...dockerHost(cwd, cpus), ...shell },
  });
}

function readValue(env: string, name: string): string {
  const match = env.match(new RegExp(`^${name}=(.*)$`, "mu"));
  if (!match?.[1]) throw new Error(`${name} is missing or empty`);
  return match[1];
}

describe("init-env", () => {
  it("writes a private .env with generated credentials and a compose project of its own", async () => {
    const directory = await checkoutWithExampleEnv();

    expect(initEnv(directory).status).toBe(0);

    const target = path.join(directory, ".env");
    const env = await readFile(target, "utf8");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(readValue(env, "POSTGRES_PASSWORD")).not.toBe(readValue(env, "VALKEY_PASSWORD"));
    expect(Buffer.from(readValue(env, "SWIZZLE_ENCRYPTION_KEY"), "base64url")).toHaveLength(32);
    expect(readValue(env, "SWIZZLE_SETUP_TOKEN").length).toBeGreaterThanOrEqual(32);
    expect(readValue(env, "SWIZZLE_ENVIRONMENT")).toBe("production");
    expect(readValue(env, "COMPOSE_PROJECT_NAME")).toMatch(/^swizzle-[0-9a-f]{8}$/u);
  });

  it("reruns successfully and never replaces the credentials of an existing .env", async () => {
    const directory = await checkoutWithExampleEnv();
    expect(initEnv(directory).status).toBe(0);
    const first = await readFile(path.join(directory, ".env"), "utf8");

    expect(initEnv(directory).status).toBe(0);
    expect(await readFile(path.join(directory, ".env"), "utf8")).toBe(first);
  });

  it("removes the obsolete image tag without changing credentials or operator settings", async () => {
    const directory = await checkoutWithExampleEnv();
    expect(initEnv(directory).status).toBe(0);
    const target = path.join(directory, ".env");
    const original = (await readFile(target, "utf8")).replace(/^SWIZZLE_IMAGE_TAG=.*\n/gmu, "");
    const existing = `${original.replace("SWIZZLE_ENVIRONMENT=production", "SWIZZLE_ENVIRONMENT=staging")}export SWIZZLE_IMAGE_TAG=v1.0.2\n  SWIZZLE_IMAGE_TAG="v1.0.2"\n`;
    await writeFile(target, existing);

    expect(initEnv(directory).status).toBe(0);
    expect(await readFile(target, "utf8")).toBe(
      original.replace("SWIZZLE_ENVIRONMENT=production", "SWIZZLE_ENVIRONMENT=staging"),
    );
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(initEnv(directory).status).toBe(0);
    expect(await readFile(target, "utf8")).toBe(
      original.replace("SWIZZLE_ENVIRONMENT=production", "SWIZZLE_ENVIRONMENT=staging"),
    );
  });

  it("publishes one complete .env when two initializers run concurrently", async () => {
    const directory = await checkoutWithExampleEnv();
    const results = await Promise.all(
      [0, 1].map(() =>
        promisify(execFile)(...initEnvCommand, {
          cwd: directory,
          encoding: "utf8",
          env: dockerHost(directory, 8),
        }),
      ),
    );

    expect(results.filter(({ stdout }) => stdout.startsWith("Created .env"))).toHaveLength(1);
    expect(
      results.filter(({ stdout }) => stdout.startsWith("Kept the existing .env")),
    ).toHaveLength(1);
    const target = path.join(directory, ".env");
    const first = await readFile(target, "utf8");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    for (const name of [
      "SWIZZLE_ENCRYPTION_KEY",
      "SWIZZLE_SETUP_TOKEN",
      "COMPOSE_PROJECT_NAME",
      "POSTGRES_PASSWORD",
      "VALKEY_PASSWORD",
    ]) {
      expect(readValue(first, name).length).toBeGreaterThanOrEqual(16);
      expect(first.match(new RegExp(`^${name}=`, "gmu"))).toHaveLength(1);
    }
    expect(initEnv(directory).status).toBe(0);
    expect(await readFile(target, "utf8")).toBe(first);
  });

  it.each([
    "SWIZZLE_ENCRYPTION_KEY",
    "SWIZZLE_SETUP_TOKEN",
    "COMPOSE_PROJECT_NAME",
    "POSTGRES_PASSWORD",
    "VALKEY_PASSWORD",
  ])("rejects a missing or blank %s without changing .env", async (name) => {
    const directory = await checkoutWithExampleEnv();
    const target = path.join(directory, ".env");
    expect(initEnv(directory).status).toBe(0);
    const env = await readFile(target, "utf8");

    for (const replacement of ["", `${name}= \t\n`]) {
      const incomplete = env.replace(new RegExp(`^${name}=.*\\n`, "mu"), replacement);
      await writeFile(target, incomplete);

      const result = initEnv(directory);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(name);
      expect(result.stderr).toMatch(/delete .*\.env.*rerun/iu);
      expect(await readFile(target, "utf8")).toBe(incomplete);
    }
  });

  it("sizes the CPU limits to a 1-CPU Docker host and keeps 2 on a larger one", async () => {
    for (const [cpus, expected] of [
      [1, "1"],
      [8, "2"],
    ] as const) {
      const directory = await checkoutWithExampleEnv();

      expect(initEnv(directory, cpus).status).toBe(0);

      const env = await readFile(path.join(directory, ".env"), "utf8");
      expect(readValue(env, "SWIZZLE_WORKER_CPUS")).toBe(expected);
      expect(readValue(env, "SWIZZLE_MAX_RUN_CPUS")).toBe(expected);
    }
  });

  it("moves a 1.0.2 .env forward to a 1-CPU Docker host and keeps its credentials", async () => {
    const directory = await checkoutWithExampleEnv();
    expect(initEnv(directory).status).toBe(0);
    const target = path.join(directory, ".env");
    // 1.0.2 wrote no SWIZZLE_WORKER_CPUS line, and SWIZZLE_MAX_RUN_CPUS=2 from its template.
    const released = (await readFile(target, "utf8"))
      .replace(/^SWIZZLE_WORKER_CPUS=.*\n/mu, "")
      .replace(/^SWIZZLE_MAX_RUN_CPUS=.*$/mu, "SWIZZLE_MAX_RUN_CPUS=2");
    await writeFile(target, released);

    expect(initEnv(directory, 1).status).toBe(0);

    const env = await readFile(target, "utf8");
    expect(readValue(env, "SWIZZLE_WORKER_CPUS")).toBe("1");
    expect(readValue(env, "SWIZZLE_MAX_RUN_CPUS")).toBe("1");
    expect(readValue(env, "SWIZZLE_ENCRYPTION_KEY")).toBe(
      readValue(released, "SWIZZLE_ENCRYPTION_KEY"),
    );
  });

  it.each(["SWIZZLE_WORKER_CPUS", "SWIZZLE_MAX_RUN_CPUS"])(
    "keeps an explicit %s that fits the Docker host and refuses one that does not",
    async (name) => {
      const directory = await checkoutWithExampleEnv();
      expect(initEnv(directory, 1).status).toBe(0);
      const target = path.join(directory, ".env");
      const explicit = (await readFile(target, "utf8")).replace(
        new RegExp(`^${name}=.*$`, "mu"),
        `${name}=1.5`,
      );
      await writeFile(target, explicit);

      expect(initEnv(directory, 2).status).toBe(0);
      expect(await readFile(target, "utf8")).toBe(explicit);

      const result = initEnv(directory, 1);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${name}=1.5`);
      expect(result.stderr).toContain("1 CPU");
      expect(await readFile(target, "utf8")).toBe(explicit);
    },
  );

  it("refuses a CPU limit above the Docker host however Compose would read it", async () => {
    const directory = await checkoutWithExampleEnv();
    expect(initEnv(directory, 1).status).toBe(0);
    const target = path.join(directory, ".env");
    const sized = await readFile(target, "utf8");

    const exported = initEnv(directory, 1, { SWIZZLE_WORKER_CPUS: "2" });
    expect(exported.status).toBe(1);
    expect(exported.stderr).toContain("SWIZZLE_WORKER_CPUS=2");
    expect(exported.stderr).toContain("shell");

    const quoted = sized.replace(
      /^SWIZZLE_WORKER_CPUS=.*$/mu,
      'SWIZZLE_WORKER_CPUS="2" # set by hand',
    );
    await writeFile(target, quoted);
    const result = initEnv(directory, 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SWIZZLE_WORKER_CPUS=2 exceeds the 1 CPU");
    expect(await readFile(target, "utf8")).toBe(quoted);
  });

  it("keeps a 1.0.2 .env's own SWIZZLE_MAX_RUN_CPUS and refuses it above the host", async () => {
    const directory = await checkoutWithExampleEnv();
    expect(initEnv(directory).status).toBe(0);
    const target = path.join(directory, ".env");
    const released = (await readFile(target, "utf8"))
      .replace(/^SWIZZLE_WORKER_CPUS=.*\n/mu, "")
      .replace(/^SWIZZLE_MAX_RUN_CPUS=.*$/mu, "SWIZZLE_MAX_RUN_CPUS=4");
    await writeFile(target, released);

    const result = initEnv(directory, 1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SWIZZLE_MAX_RUN_CPUS=4 exceeds the 1 CPU");
    expect(await readFile(target, "utf8")).toBe(released);
  });

  it("rejects a local worker token the API would refuse, without changing .env", async () => {
    const directory = await checkoutWithExampleEnv();
    expect(initEnv(directory).status).toBe(0);
    const target = path.join(directory, ".env");
    const env = await readFile(target, "utf8");

    for (const token of ["0123456789abcdef".repeat(4), "swz_short"]) {
      const earlier = env.replace(
        /^SWIZZLE_LOCAL_WORKER_TOKEN=.*$/mu,
        `SWIZZLE_LOCAL_WORKER_TOKEN=${token}`,
      );
      await writeFile(target, earlier);

      const result = initEnv(directory);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("SWIZZLE_LOCAL_WORKER_TOKEN");
      expect(result.stderr).toMatch(/delete .*\.env.*rerun/iu);
      expect(result.stderr).not.toMatch(/^\s+at /mu);
      expect(await readFile(target, "utf8")).toBe(earlier);
    }
  });
});
