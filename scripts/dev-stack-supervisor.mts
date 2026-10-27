// Owns a detached process group until every command descendant has stopped. The command's
// exit travels over IPC; it does not release the group leader's PID incarnation.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { stopTimeoutMs } from "./dev-stack-timeout.ts";

/** The command exit reported to the dev-stack orchestrator over its private IPC channel. */
export interface CommandExit {
  readonly code: number;
}

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // A live command forwards SIGTERM to its own children, and turbo force-kills its tasks on a
  // second signal, so only the command gets it. Once the command is gone, the group signal is the
  // only one its descendants get.
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  else process.kill(-process.pid, "SIGTERM");
  const deadline = Date.now() + stopTimeoutMs;
  while (await hasLiveDescendants()) {
    if (Date.now() >= deadline) {
      // The supervisor is still the leader, so the group ID cannot have been reused.
      process.kill(-process.pid, "SIGKILL");
    }
    await delay(100);
  }
  process.exit(0);
}

async function hasLiveDescendants(): Promise<boolean> {
  const scan = spawn("ps", ["-ax", "-o", "pid=,pgid=,stat="], {
    // Keep ps outside the services group so repeated SIGTERM cannot kill it.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  scan.stdout.on("data", (data) => {
    stdout += data;
  });
  scan.stderr.on("data", (data) => {
    stderr += data;
  });
  const [status, signal] = await once(scan, "close");
  // Node moves a detached child out of this group only after the fork, so a signal to the group
  // can still reach ps there. That scan saw nothing; the caller scans again.
  if (signal !== null) return true;
  if (status !== 0) throw new Error(`Cannot inspect process group: ${stderr}`);
  return stdout.split("\n").some((line) => {
    const [pid, group, state] = line.trim().split(/\s+/u);
    return Number(group) === process.pid && Number(pid) !== process.pid && !state?.startsWith("Z");
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void stop());
}
process.on("disconnect", () => void stop());

const [command, ...args] = process.argv.slice(2);
if (command === undefined) throw new Error("Expected a command to supervise");
const child = spawn(command, args, { stdio: "inherit" });
const report = (code: number) => {
  if (process.connected) {
    process.send?.({ code } satisfies CommandExit, (error) => {
      if (error) void stop();
    });
  } else void stop();
};
child.once("error", (error) => {
  process.stderr.write(`dev-stack: ${error.message}\n`);
  report(1);
});
child.once("exit", (code) => report(code ?? 1));
