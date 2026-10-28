import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../test/support.js";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("upgrade.ts", import.meta.url));

async function installedCheckout() {
  const directory = await temporaryDirectory("swizzle-upgrade-command-");
  const checkout = path.join(directory, "checkout");
  const origin = path.join(directory, "origin.git");
  const bin = path.join(directory, "bin");
  await mkdir(checkout);
  await mkdir(bin);
  const git = async (...args: string[]) =>
    (await execute("git", args, { cwd: checkout })).stdout.trim();
  await git("init", "--initial-branch=installed");
  await git("config", "user.email", "test@swizzle.test");
  await git("config", "user.name", "Upgrade test");
  await mkdir(path.join(checkout, "scripts"));
  await copyFile(script, path.join(checkout, "scripts/upgrade.ts"));
  await writeFile(path.join(checkout, ".gitignore"), ".env\n");
  await writeFile(path.join(checkout, ".env"), "SWIZZLE_ENCRYPTION_KEY=test-key\n");
  await writeFile(path.join(checkout, "package.json"), '{"version":"1.0.2"}');
  await writeFile(
    path.join(checkout, "justfile"),
    `set shell := ["bash", "-euo", "pipefail", "-c"]
upgrade tag="":
    node scripts/upgrade.ts {{ quote(tag) }}
backup dir:
    test "\u0024{UPGRADE_TEST_FAILURE:-}" != backup
    mkdir -p {{ quote(dir) }}
    git rev-parse HEAD > {{ quote(dir) }}/source
    echo durable-data > {{ quote(dir) }}/database.sql
stack:
    test "\u0024{UPGRADE_TEST_FAILURE:-}" != migrate
    git rev-parse HEAD > .git/stack-head
`,
  );
  await writeFile(path.join(checkout, "operator-config"), "installed setting\n");
  await git("add", ".");
  await git("commit", "-m", "Installed release");
  const previous = await git("rev-parse", "HEAD");
  await git("tag", "v1.0.2");
  await writeFile(path.join(checkout, "package.json"), '{"version":"1.0.3"}');
  await git("add", ".");
  await git("commit", "-m", "New release");
  const target = await git("rev-parse", "HEAD");
  await git("tag", "--annotate", "v1.0.3", "--message", "New release");
  await git("tag", "v2.0.0-rc.1");
  await execute("git", ["clone", "--bare", checkout, origin]);
  await git("remote", "add", "origin", origin);
  await git("checkout", "--detach", previous);
  await writeFile(
    path.join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> .git/docker-calls
case " $* " in *" exec "*) test "\u0024{UPGRADE_TEST_FAILURE:-}" != health ;; esac
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  const upgrade = (...tags: string[]) => execute("just", ["upgrade", ...tags], { cwd: checkout });
  const backups = () => readdir(path.join(checkout, ".git/swizzle-upgrades")).catch(() => []);
  return { checkout, git, upgrade, previous, target, backups };
}

it.each([{ args: [] }, { args: ["v1.0.3"] }])(
  "backs up the original checkout before selecting the named or newest stable release (%j)",
  async ({ args }) => {
    const installed = await installedCheckout();
    const { stdout } = await installed.upgrade(...args);
    expect(await installed.git("rev-parse", "HEAD")).toBe(installed.target);
    expect(await readFile(path.join(installed.checkout, ".git/stack-head"), "utf8")).toBe(
      `${installed.target}\n`,
    );
    expect(stdout).toContain(`to v1.0.3 (${installed.target})`);
    expect(stdout).toContain("/health reports 1.0.3");
    const [name] = await installed.backups();
    expect(name).toBeDefined();
    const directory = path.join(installed.checkout, ".git/swizzle-upgrades", name ?? "");
    expect(await readFile(path.join(directory, "backup/source"), "utf8")).toBe(
      `${installed.previous}\n`,
    );
    expect(await readFile(path.join(directory, "env"), "utf8")).toBe(
      "SWIZZLE_ENCRYPTION_KEY=test-key\n",
    );
  },
);

it.each(["tracked", "untracked", "staged"])(
  "refuses a %s change without changing the checkout or invoking the stack",
  async (kind) => {
    const installed = await installedCheckout();
    await writeFile(
      path.join(installed.checkout, kind === "untracked" ? "operator.txt" : "operator-config"),
      "operator change\n",
    );
    if (kind === "staged") await installed.git("add", "operator-config");
    const before = await installed.git("status", "--porcelain");
    await expect(installed.upgrade("v1.0.3")).rejects.toMatchObject({
      stderr: expect.stringContaining("Checkout has uncommitted changes"),
    });
    expect(await installed.git("status", "--porcelain")).toBe(before);
    expect(await installed.git("rev-parse", "HEAD")).toBe(installed.previous);
    expect(await installed.backups()).toEqual([]);
    expect(
      await readFile(path.join(installed.checkout, ".git/docker-calls"), "utf8").catch(() => ""),
    ).toBe("");
    expect(
      await readFile(path.join(installed.checkout, ".git/FETCH_HEAD"), "utf8").catch(() => ""),
    ).toBe("");
  },
);

it.each(["backup", "migrate", "health"])(
  "leaves actionable recovery output after a %s failure",
  async (failure) => {
    const installed = await installedCheckout();
    vi.stubEnv("UPGRADE_TEST_FAILURE", failure);
    await expect(installed.upgrade("v1.0.3")).rejects.toMatchObject({
      stdout: expect.stringContaining(
        failure === "backup"
          ? "Restart it with: just stack"
          : `Restore with: git checkout --detach ${installed.previous}`,
      ),
    });
    const [name] = await installed.backups();
    expect(name).toBeDefined();
    expect(await installed.git("rev-parse", "HEAD")).toBe(
      failure === "backup" ? installed.previous : installed.target,
    );
    if (failure !== "backup") {
      expect(
        await readFile(
          path.join(installed.checkout, ".git/swizzle-upgrades", name ?? "", "backup/database.sql"),
          "utf8",
        ),
      ).toBe("durable-data\n");
    }
  },
);

it("selects the newest stable tag on origin despite a higher local-only tag", async () => {
  const installed = await installedCheckout();
  await installed.git("tag", "v99.0.0", installed.previous);

  const { stdout } = await installed.upgrade();

  expect(await installed.git("rev-parse", "HEAD")).toBe(installed.target);
  expect(stdout).toContain(`to v1.0.3 (${installed.target})`);
  expect(await installed.git("rev-parse", "v99.0.0")).toBe(installed.previous);
});

it("resolves the named tag from origin when a local tag points elsewhere", async () => {
  const installed = await installedCheckout();
  await installed.git("tag", "--force", "v1.0.3", installed.previous);

  await installed.upgrade("v1.0.3");

  expect(await installed.git("rev-parse", "HEAD")).toBe(installed.target);
  expect(await installed.git("rev-parse", "v1.0.3")).toBe(installed.previous);
});

it("refuses a named local-only tag before backing up or stopping the stack", async () => {
  const installed = await installedCheckout();
  await installed.git("tag", "v99.0.0", installed.previous);

  await expect(installed.upgrade("v99.0.0")).rejects.toMatchObject({
    stderr: expect.stringContaining("Release tag v99.0.0 was not found on origin"),
  });
  expect(await installed.git("rev-parse", "HEAD")).toBe(installed.previous);
  expect(await installed.backups()).toEqual([]);
  expect(
    await readFile(path.join(installed.checkout, ".git/docker-calls"), "utf8").catch(() => ""),
  ).toBe("");
});
