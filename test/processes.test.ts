import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { killLeftProcesses } from "./processes.js";
import { temporaryDirectories, temporaryDirectory, waitFor } from "./support.js";

it("kills and names a process whose parent exited, by the test directory it runs in", async ({
  signal,
}) => {
  const directory = await temporaryDirectory("swizzle-orphan-");
  // The shell exits at once; Linux hands its background sleep to another parent.
  const parent = spawn("sh", ["-c", "sleep 300 > /dev/null 2>&1 & echo $!"], {
    cwd: directory,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  parent.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await once(parent, "close");
  const orphan = Number(output.trim());
  expect(isRunning(orphan)).toBe(true);

  expect(() => killLeftProcesses(temporaryDirectories)).toThrow(`${orphan} sleep 300`);
  await waitFor(signal, () => !isRunning(orphan));
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
