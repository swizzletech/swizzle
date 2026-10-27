import { execFile, spawnSync } from "node:child_process";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../test/support.js";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

async function checkoutWithExampleEnv(): Promise<string> {
  const directory = await temporaryDirectory("swizzle-init-env-");
  await copyFile(path.join(repoRoot, ".env.example"), path.join(directory, ".env.example"));
  return directory;
}

// Runs the script as `just init-env` does: Node strips its types, so no loader starts with it.
const initEnvCommand = [process.execPath, [path.join(repoRoot, "scripts/init-env.ts")]] as const;

function initEnv(cwd: string) {
  return spawnSync(...initEnvCommand, { cwd, encoding: "utf8" });
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
    expect(readValue(env, "COMPOSE_PROJECT_NAME")).toMatch(/^swizzle-[0-9a-f]{8}$/u);
  });

  it("reruns successfully and never replaces the credentials of an existing .env", async () => {
    const directory = await checkoutWithExampleEnv();
    expect(initEnv(directory).status).toBe(0);
    const first = await readFile(path.join(directory, ".env"), "utf8");

    expect(initEnv(directory).status).toBe(0);
    expect(await readFile(path.join(directory, ".env"), "utf8")).toBe(first);
  });

  it("publishes one complete .env when two initializers run concurrently", async () => {
    const directory = await checkoutWithExampleEnv();
    const results = await Promise.all(
      [0, 1].map(() =>
        promisify(execFile)(...initEnvCommand, { cwd: directory, encoding: "utf8" }),
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
});
