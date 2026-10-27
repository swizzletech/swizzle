import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import { readProcessIdentity } from "../scripts/process-identity.ts";
import { temporaryDirectory } from "./support.js";

const source = fileURLToPath(new URL("..", import.meta.url));

export async function fixture() {
  const root = await temporaryDirectory("swizzle-owner-");
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
  await mkdir(bin);
  for (const name of ["docker", "chrome-devtools-axi"]) {
    await writeFile(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  const state = path.join(root, ".git/swizzle-dev-fresh");
  await mkdir(state);
  return { root, env, state };
}

export async function ownedProcess(root: string) {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "scripts/dev-stack.mts", root],
    { cwd: root, detached: true, stdio: "ignore" },
  );
  await once(child, "spawn");
  const pid = child.pid;
  if (pid === undefined) throw new Error("Expected a running process");
  onTestFinished(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  });
  const identity = readProcessIdentity(pid);
  if (identity === undefined) throw new Error("Expected an identifiable process");
  return { child, pid, incarnation: identity.incarnation };
}

export function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function invoke(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
}
