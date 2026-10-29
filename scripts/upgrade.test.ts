import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { diskSpace } from "../test/disk-space.js";
import { temporaryDirectory } from "../test/support.js";

import { capture, prepareImages, releaseVersion, run } from "./stack-images.ts";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("upgrade.ts", import.meta.url));

async function installedCheckout() {
  diskSpace(64);
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
  await mkdir(path.join(checkout, ".github/workflows"), { recursive: true });
  await writeFile(path.join(checkout, ".github/workflows/images.yml"), "name: Fixture images\n");
  await copyFile(script, path.join(checkout, "scripts/upgrade.ts"));
  await copyFile(new URL("stack.ts", import.meta.url), path.join(checkout, "scripts/stack.ts"));
  await copyFile(
    new URL("stack-images.ts", import.meta.url),
    path.join(checkout, "scripts/stack-images.ts"),
  );
  await writeFile(path.join(checkout, "scripts/init-env.ts"), "export {};\n");
  await writeFile(path.join(checkout, ".gitignore"), ".env\n");
  await writeFile(
    path.join(checkout, "Dockerfile"),
    "FROM alpine:3.24.3\nRUN pnpm exec turbo run build\n",
  );
  await writeFile(path.join(checkout, ".env"), "SWIZZLE_ENCRYPTION_KEY=test-key\n");
  await writeFile(path.join(checkout, "package.json"), '{"version":"1.0.2"}');
  await writeFile(
    path.join(checkout, "justfile"),
    `compose := "docker compose"
set shell := ["bash", "-euo", "pipefail", "-c"]
upgrade tag="":
    node scripts/upgrade.ts {{ quote(tag) }}
backup dir:
    test "\u0024{UPGRADE_TEST_FAILURE:-}" != backup
    mkdir -p {{ quote(dir) }}
    git rev-parse HEAD > {{ quote(dir) }}/source
    echo durable-data > {{ quote(dir) }}/database.sql
stack:
    node scripts/stack.ts up
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
set -e
printf '%s\\n' "$*" >> '${checkout}/.git/docker-calls'
case " $* " in
  *" build "*)
    image=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    if [ "\u0024{UPGRADE_TEST_FAILURE:-}" = moved-tag ]; then
      case "$*" in
        *"test-upgrade-backup:local"*) image=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
      esac
    fi
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --iidfile ]; then printf '%s\\n' "$image" > "$2"; break; fi
      shift
    done ;;
  *" pull "*)
    case "\u0024{UPGRADE_TEST_FAILURE:-}" in
      first-missing) case "$*" in *swizzle-api:1.0.3) echo 'manifest unknown' >&2; exit 1 ;; esac ;;
      registry) echo 'network unavailable' >&2; exit 1 ;;
      partial) case "$*" in *swizzle-backup:1.0.3) echo 'manifest unknown' >&2; exit 1 ;; esac ;;
      absent) echo 'manifest unknown' >&2; exit 1 ;;
      dependency-offline) case "$*" in *postgres:17) echo 'network unavailable' >&2; exit 1 ;; esac ;;
    esac ;;
  *" info "*) echo /tmp ;;
  *" config "*) echo '{"name":"test-upgrade","services":{"api":{"build":{"context":".","dockerfile":"Dockerfile","target":"service"}},"backup":{"build":{"context":".","dockerfile":"Dockerfile","target":"cli"}},"postgres":{"image":"postgres:17"}}}' ;;
  *" ps "*)
    case "$*" in
      *"--quiet api") case "\u0024{UPGRADE_TEST_FAILURE:-}" in
        same-images|different-images) printf '%s\\n' container-a container-b ;;
      esac ;;
    esac ;;
  *" inspect "*)
    case "$*" in
      "image inspect postgres:17") case "\u0024{UPGRADE_TEST_FAILURE:-}" in
        dependency-pull|dependency-offline) exit 1 ;;
      esac ;;
    esac
    case "$*" in
      *"test-upgrade-api:local")
        if [ "\u0024{UPGRADE_TEST_FAILURE:-}" = moved-tag ]; then
          echo sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
        else
          echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        fi ;;
      *"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        echo sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
      *"container-a container-b")
        echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        if [ "\u0024{UPGRADE_TEST_FAILURE:-}" = different-images ]; then
          echo sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        else
          echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        fi ;;
      *) echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    esac ;;
  *" up "*) test "\u0024{UPGRADE_TEST_FAILURE:-}" != migrate; git rev-parse HEAD > .git/stack-head ;;
  *" exec "*) test "\u0024{UPGRADE_TEST_FAILURE:-}" != health ;;
esac
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  const upgrade = (...tags: string[]) => execute("just", ["upgrade", ...tags], { cwd: checkout });
  const backups = () => readdir(path.join(checkout, ".git/swizzle-upgrades")).catch(() => []);
  return { checkout, git, upgrade, previous, target, backups };
}

it.each(["upgrade", "stack"].flatMap((command) => [1, 8].map((gib) => ({ command, gib }))))(
  "refuses just $command with $gib GiB free before stopping or building",
  async ({ command, gib }) => {
    const installed = await installedCheckout();
    diskSpace(gib);
    vi.stubEnv("UPGRADE_TEST_FAILURE", "absent");
    if (command === "stack" && gib === 8)
      await writeFile(path.join(installed.checkout, "operator-config"), "source build\n");

    await expect(
      execute("just", [command, ...(command === "upgrade" ? ["v1.0.3"] : [])], {
        cwd: installed.checkout,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `Need at least ${gib === 1 ? 5 : 12} GiB free at /tmp for ${gib === 1 ? "release images" : "source builds"} and backup`,
      ),
    });
    expect(await installed.git("rev-parse", "HEAD")).toBe(installed.previous);
    const calls = await readFile(path.join(installed.checkout, ".git/docker-calls"), "utf8");
    expect(calls).not.toContain(" stop ");
    expect(calls).not.toContain(" build ");
  },
);

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
          ? "Restart it with: docker compose -f"
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
  ).not.toContain(" stop ");
});

it.each(["registry", "partial"])(
  "refuses %s image failure before stopping the installed stack",
  async (failure) => {
    const installed = await installedCheckout();
    vi.stubEnv("UPGRADE_TEST_FAILURE", failure);
    await expect(installed.upgrade("v1.0.3")).rejects.toMatchObject({
      stderr: expect.stringContaining("Cannot pull"),
    });
    expect(await installed.git("rev-parse", "HEAD")).toBe(installed.previous);
    const calls = await readFile(path.join(installed.checkout, ".git/docker-calls"), "utf8");
    expect(calls).not.toContain(" stop ");
    expect(calls).not.toContain(" build ");
  },
);

it.each(["dependency-pull", "dependency-offline"])(
  "prepares a missing dependency before stopping writers (%s)",
  async (failure) => {
    const installed = await installedCheckout();
    vi.stubEnv("UPGRADE_TEST_FAILURE", failure);
    if (failure === "dependency-offline") {
      await expect(installed.upgrade("v1.0.3")).rejects.toMatchObject({
        stderr: expect.stringContaining("network unavailable"),
      });
      expect(await installed.git("rev-parse", "HEAD")).toBe(installed.previous);
    } else {
      await installed.upgrade("v1.0.3");
      expect(await installed.git("rev-parse", "HEAD")).toBe(installed.target);
    }
    const calls = (
      await readFile(path.join(installed.checkout, ".git/docker-calls"), "utf8")
    ).split("\n");
    const pull = calls.indexOf("pull postgres:17");
    expect(calls[pull]).toBe("pull postgres:17");
    const stop = calls.findIndex((call) => call.includes(" stop "));
    if (failure === "dependency-offline") expect(stop).toBe(-1);
    else {
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(calls.slice(0, stop)).toContain("pull postgres:17");
    }
  },
);

it("builds each absent release image separately before stopping writers", async () => {
  const installed = await installedCheckout();
  vi.stubEnv("UPGRADE_TEST_FAILURE", "absent");
  await installed.upgrade("v1.0.3");
  const calls = (await readFile(path.join(installed.checkout, ".git/docker-calls"), "utf8")).split(
    "\n",
  );
  const builds = calls.filter((call) => call.includes(" build "));
  expect(builds).toHaveLength(2);
  const [name] = await installed.backups();
  const serial = await readFile(
    path.join(installed.checkout, ".git/swizzle-upgrades", name ?? "", "Dockerfile.serial-0"),
    "utf8",
  );
  expect(serial).toBe("FROM alpine:3.24.3\nRUN pnpm exec turbo run build --concurrency=1\n");
  expect(await readFile(path.join(installed.checkout, "Dockerfile"), "utf8")).toBe(
    "FROM alpine:3.24.3\nRUN pnpm exec turbo run build\n",
  );
  expect(
    builds.every(
      (call) =>
        call.startsWith("buildx build --load ") &&
        /com.docker.compose.service=(?:api|backup)/u.test(call),
    ),
  ).toBe(true);
  expect(
    calls
      .slice(calls.findIndex((call) => call.includes(" stop ")))
      .some((call) => call.includes(" build ")),
  ).toBe(false);
});

it("refuses a partial release whose first package is missing", async () => {
  const installed = await installedCheckout();
  vi.stubEnv("UPGRADE_TEST_FAILURE", "first-missing");
  await expect(installed.upgrade("v1.0.3")).rejects.toMatchObject({
    stderr: expect.stringContaining("incomplete image publication"),
  });
  const calls = await readFile(path.join(installed.checkout, ".git/docker-calls"), "utf8");
  expect(calls).not.toContain(" stop ");
  expect(calls).not.toContain(" build ");
});

it("selects source for tracked local changes on a release tag", async () => {
  const installed = await installedCheckout();
  const source = { root: installed.checkout, envFile: path.join(installed.checkout, ".env") };
  expect(releaseVersion(source)).toBe("1.0.2");
  await writeFile(path.join(installed.checkout, "operator-config"), "local source override\n");
  expect(releaseVersion(source)).toBeUndefined();
});

it("builds a release that predates the publishing workflow without probing the registry", async () => {
  const installed = await installedCheckout();
  await installed.git("rm", ".github/workflows/images.yml");
  await writeFile(path.join(installed.checkout, "package.json"), '{"version":"1.0.4"}');
  await installed.git("add", "package.json");
  await installed.git("commit", "-m", "Release without image publishing");
  await installed.git("tag", "v1.0.4");
  vi.stubEnv("UPGRADE_TEST_FAILURE", "registry");
  const source = { root: installed.checkout, envFile: path.join(installed.checkout, ".env") };
  expect(releaseVersion(source)).toBe("1.0.4");
  prepareImages(source, path.join(installed.checkout, ".git/prepared/compose.json"));
  const calls = await readFile(path.join(installed.checkout, ".git/docker-calls"), "utf8");
  expect(calls).not.toContain(" pull ");
  expect(calls.split("\n").filter((call) => call.startsWith("buildx build --load "))).toHaveLength(
    2,
  );
});

it("refuses ambiguous installed images before stopping writers or publishing rollback", async () => {
  const installed = await installedCheckout();
  vi.stubEnv("UPGRADE_TEST_FAILURE", "different-images");
  await expect(installed.upgrade("v1.0.3")).rejects.toMatchObject({
    stderr: expect.stringContaining("Service api has containers with different images"),
  });
  expect(await installed.git("rev-parse", "HEAD")).toBe(installed.previous);
  const calls = await readFile(path.join(installed.checkout, ".git/docker-calls"), "utf8");
  expect(calls).not.toContain(" stop ");
  const [name] = await installed.backups();
  expect(
    await readdir(path.join(installed.checkout, ".git/swizzle-upgrades", name ?? "")),
  ).not.toContain("rollback.json");
});

it("pins one rollback image when several containers use the same image", async () => {
  const installed = await installedCheckout();
  vi.stubEnv("UPGRADE_TEST_FAILURE", "same-images");
  await installed.upgrade("v1.0.3");
  const [name] = await installed.backups();
  const rollback = JSON.parse(
    await readFile(
      path.join(installed.checkout, ".git/swizzle-upgrades", name ?? "", "rollback.json"),
      "utf8",
    ),
  );
  expect(rollback.services.api.image).toBe(
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
});

it.each(["up", "prepare"])("gives a retry instruction when %s preflight fails", async (command) => {
  const root = await temporaryDirectory("swizzle-preflight-");
  await expect(
    execute(
      process.execPath,
      [
        fileURLToPath(new URL("stack.ts", import.meta.url)),
        command,
        ...(command === "prepare" ? [path.join(root, "compose.json")] : []),
      ],
      { cwd: root, env: { ...process.env, PATH: root } },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "Missing or unusable git. Install it and put it on PATH before retrying.",
    ),
  });
});

it("passes paths and metacharacters as arguments without shell interpretation", async () => {
  const root = await temporaryDirectory("swizzle-command-args-");
  const directory = path.join(root, "checkout '$() ; quoted");
  await mkdir(directory);
  run("git", ["init", "--initial-branch=fixture", directory]);
  const value = "literal $(touch injected); '$VALUE'";
  run("git", ["config", "swizzle.literal", value], directory);
  expect(capture("git", ["config", "swizzle.literal"], directory)).toBe(value);
  expect(capture("git", ["rev-parse", "--show-toplevel"], directory)).toBe(directory);
  expect(await readdir(directory)).toEqual([".git"]);
});

it("pins each source build even when another preparation moves its shared tag", async () => {
  const installed = await installedCheckout();
  await writeFile(path.join(installed.checkout, "operator-config"), "source build\n");
  vi.stubEnv("UPGRADE_TEST_FAILURE", "moved-tag");
  const source = { root: installed.checkout, envFile: path.join(installed.checkout, ".env") };
  const prepared = prepareImages(
    source,
    path.join(installed.checkout, ".git/prepared/compose.json"),
    { tag: "local" },
  );
  expect(prepared.images).toEqual({
    api: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    backup: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
});
