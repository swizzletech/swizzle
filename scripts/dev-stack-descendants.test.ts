import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFailed, onTestFinished, test } from "vitest";
import { processesNaming } from "../test/processes.js";
import { temporaryDirectory, waitFor } from "../test/support.js";
import { readProcessIdentity } from "./process-identity.ts";

const source = fileURLToPath(new URL("..", import.meta.url));

/**
 * A git worktree with the dev stack's scripts, stubs for docker, pnpm and tailscale on `bin`, and
 * `turboScript` as node_modules/.bin/turbo, the command the stack runs its services with.
 */
async function stackRoot(turboScript: string) {
  const root = await temporaryDirectory("swizzle-descendants-");
  await mkdir(path.join(root, "scripts"));
  for (const file of [
    "dev-stack.mts",
    "dev-stack-supervisor.mts",
    "dev-stack-timeout.ts",
    "env-file.ts",
    "process-identity.ts",
  ]) {
    await cp(path.join(source, "scripts", file), path.join(root, "scripts", file));
  }
  // dev-stack.mts runs the stack's mail server from here.
  await mkdir(path.join(root, "test"));
  await cp(path.join(source, "test", "mail-sink.ts"), path.join(root, "test", "mail-sink.ts"));
  execFileSync("git", ["init", "--quiet", root]);
  await writeFile(path.join(root, "justfile"), "dev-down:\n    node scripts/dev-stack.mts down\n");
  const bin = path.join(root, "bin");
  const turbo = path.join(root, "node_modules/.bin");
  await mkdir(bin);
  await mkdir(turbo, { recursive: true });
  for (const name of ["docker", "pnpm", "tailscale"]) {
    await writeFile(
      path.join(bin, name),
      name === "tailscale"
        ? "#!/bin/sh\nexit 1\n"
        : '#!/bin/sh\ncase " $* " in *" port "*) echo 127.0.0.1:1;; esac\n',
      { mode: 0o755 },
    );
  }
  await writeFile(path.join(turbo, "turbo"), `#!${process.execPath}\n${turboScript}`, {
    mode: 0o755,
  });
  return { root, bin };
}

// turbo's npm shim forwards SIGTERM to the turbo binary, which force-kills its tasks on a second
// signal, so the services stop gracefully only when the binary gets exactly one.
test.skipIf(process.platform !== "linux")(
  "just dev-down signals the services command once, so a forwarding command stops gracefully",
  async ({ signal }) => {
    const { root, bin } = await stackRoot(`
const { spawn } = require('node:child_process');
const binary = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => { require('node:fs').appendFileSync('signals.txt', 'TERM;'); setTimeout(() => process.exit(0), 300); }); require('node:fs').writeFileSync('ready', ''); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
process.on('SIGTERM', () => binary.kill('SIGTERM'));
binary.on('exit', (code) => process.exit(code ?? 1));
`);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_CONFIG_HOME: path.join(root, "config"),
    };
    const stack = spawn(process.execPath, ["scripts/dev-stack.mts", "fresh"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    const stackExit = once(stack, "exit");
    onTestFinished(async () => {
      stack.kill("SIGKILL");
      await stackExit;
    });
    await waitFor(signal, () => existsSync(path.join(root, "ready")));

    const down = spawn("just", ["dev-down"], { cwd: root, env, stdio: "ignore" });
    const [code] = await once(down, "close");

    expect(code).toBe(0);
    expect(await readFile(path.join(root, "signals.txt"), "utf8")).toBe("TERM;");
  },
  40_000,
);

for (const phase of [
  "shutdown",
  "orphaned",
  "service-exit",
  "early-cleanup",
  "failed-cleanup",
  "census-signal",
] as const) {
  test.skipIf(process.platform !== "linux")(
    `just dev-down kills a stubborn descendant after its command leader exits: ${phase}`,
    async ({ signal }) => {
      const { root, bin } = await stackRoot(`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.on('message', () => writeFileSync('planted.json', JSON.stringify({ leader: process.pid, child: child.pid })));
setInterval(() => {}, 1000);
`);
      if (phase === "census-signal") {
        await writeFile(
          path.join(bin, "ps"),
          `#!/bin/sh
if [ -f census-arm ]; then
  echo $$ > census.pid
  while [ ! -f census-release ]; do sleep 0.01; done
fi
exec /usr/bin/ps "$@"
`,
          { mode: 0o755 },
        );
      }
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SWIZZLE_DEV_STOP_TIMEOUT_MS: "100",
        XDG_CONFIG_HOME: path.join(root, "config"),
      };
      const stack = spawn(process.execPath, ["scripts/dev-stack.mts", "fresh"], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stackLog = "";
      stack.stdout.on("data", (data) => {
        stackLog += data;
      });
      stack.stderr.on("data", (data) => {
        stackLog += data;
      });
      const stackExit = once(stack, "exit");
      let group: { pid: number; incarnation: string } | undefined;
      const cleanup = async (cleanupSignal: AbortSignal) => {
        if (phase === "census-signal") await writeFile(path.join(root, "census-release"), "");
        try {
          const down = spawn("just", ["dev-down"], { cwd: root, env, stdio: "ignore" });
          await once(down, "close");
        } finally {
          // Startup can fail before the test reads either fixture record.
          const record: { groups: { pid: number; incarnation: string }[] } | null = await readFile(
            path.join(root, ".git/swizzle-dev-fresh/stack.json"),
            "utf8",
          )
            .then(JSON.parse)
            .catch(() => null);
          const planted: { leader: number; child: number } | null = await readFile(
            path.join(root, "planted.json"),
            "utf8",
          )
            .then(JSON.parse)
            .catch(() => null);
          const groups = group === undefined ? (record?.groups ?? []) : [group];
          const owned = new Map<number, string>();
          for (const pid of [...groups.map(({ pid }) => pid), planted?.leader, planted?.child]) {
            if (pid === undefined) continue;
            const identity = readProcessIdentity(pid);
            const expected = groups.find((candidate) => candidate.pid === pid);
            if (
              identity?.root === root &&
              (expected === undefined || expected.incarnation === identity.incarnation)
            )
              owned.set(pid, identity.incarnation);
          }
          stack.kill("SIGKILL");
          await stackExit;
          for (const candidate of groups) {
            if (owned.get(candidate.pid) !== candidate.incarnation) continue;
            if (readProcessIdentity(candidate.pid)?.incarnation !== candidate.incarnation) continue;
            try {
              process.kill(-candidate.pid, "SIGKILL");
            } catch {}
          }
          for (const [pid, incarnation] of owned) {
            if (readProcessIdentity(pid)?.incarnation !== incarnation) continue;
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
          await waitFor(cleanupSignal, () =>
            [...owned].every(
              ([pid, incarnation]) => readProcessIdentity(pid)?.incarnation !== incarnation,
            ),
          );
          // A supervisor killed mid-scan leaves its detached ps behind, which ends on its own.
          await waitFor(cleanupSignal, () => processesNaming(new Set([root])).length === 0);
        }
      };
      onTestFinished(({ signal: finishedSignal }) => cleanup(finishedSignal), 40_000);
      onTestFailed(() => {
        console.error(`The stack's output:\n${stackLog}`);
      });
      await waitFor(signal, () =>
        readFile(path.join(root, "planted.json"), "utf8")
          .then(JSON.parse)
          .then(
            () => true,
            () => false,
          ),
      );
      const planted: { leader: number; child: number } = JSON.parse(
        await readFile(path.join(root, "planted.json"), "utf8"),
      );
      if (phase === "early-cleanup" || phase === "failed-cleanup") {
        if (phase === "failed-cleanup") {
          await writeFile(path.join(root, "justfile"), "dev-down:\n    exit 1\n");
        }
        await cleanup(signal);
        expect(readProcessIdentity(planted.child)).toBeUndefined();
        expect(readProcessIdentity(planted.leader)).toBeUndefined();
        return;
      }
      const record = JSON.parse(
        await readFile(path.join(root, ".git/swizzle-dev-fresh/stack.json"), "utf8"),
      );
      group = record.groups[0];
      expect(readProcessIdentity(planted.child)?.root).toBe(root);
      if (group === undefined) throw new Error("Expected the services process group");
      if (phase === "census-signal") {
        await writeFile(path.join(root, "census-arm"), "");
        stack.kill("SIGKILL");
        await stackExit;
        await waitFor(signal, () => existsSync(path.join(root, "census.pid")));
        process.kill(-group.pid, "SIGTERM");
        await writeFile(path.join(root, "census-release"), "");
      }
      if (phase === "orphaned") {
        process.kill(group.pid, "SIGSTOP");
      }
      if (phase !== "shutdown" && phase !== "census-signal") {
        process.kill(planted.leader, "SIGTERM");
        await waitFor(signal, () => readProcessIdentity(planted.leader) === undefined);
      }
      if (phase === "orphaned") {
        stack.kill("SIGKILL");
        await stackExit;
        process.kill(group.pid, "SIGCONT");
      }
      const down = spawn("just", ["dev-down"], { cwd: root, env });
      let output = "";
      down.stdout.on("data", (data) => {
        output += data;
      });
      down.stderr.on("data", (data) => {
        output += data;
      });
      const [code] = await once(down, "close");
      expect(code, output).toBe(0);
      // dev-down has exited, so a planted child it killed is gone once the kernel reaps it.
      await waitFor(signal, () => readProcessIdentity(planted.child) === undefined);
      expect(readProcessIdentity(planted.leader)).toBeUndefined();
      expect(readProcessIdentity(group?.pid ?? 0)).toBeUndefined();
    },
    // Includes startup and cleanup under competing gates; the fixture's grace is 100 ms.
    40_000,
  );
}
