// Finds the processes a test file started that are still running, for test/process-leaks.ts.
// Linux only, where /proc names each process's children, command line, working directory and
// environment without starting one more.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

interface RunningProcess {
  readonly pid: number;
  readonly command: string;
}

/**
 * Kills the processes this worker's tests left running and throws a list of them. A process is
 * the tests' when it descends from this worker, or when its command line, working directory or
 * environment names one of `directories`, the test file's temporary directories: a fake `docker`
 * in one is on its PATH, and an automation runs in one. The second rule finds a process whose
 * parent exited, which Linux hands to another parent.
 */
export function killLeftProcesses(directories: ReadonlySet<string>): void {
  if (process.platform !== "linux") return;
  const running = new Map<number, string>();
  for (const { pid, command } of [
    ...runningDescendants(process.pid),
    ...processesNaming(directories),
  ]) {
    // esbuild's API runs one service per process and the service exits with its parent.
    if (!/\/esbuild --service=/u.test(command)) running.set(pid, command);
  }
  if (running.size === 0) return;
  for (const pid of running.keys()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It exited after the check read it.
    }
  }
  throw new Error(
    `This test, or one before it in this file that timed out, left ${running.size} processes running, now killed:\n${[
      ...running,
    ]
      .map(([pid, command]) => `  ${pid} ${command}`)
      .join("\n")}`,
  );
}

function runningDescendants(pid: number): RunningProcess[] {
  return childrenOf(pid).flatMap((child) => {
    const command = commandOf(child);
    const self = command === "" ? [] : [{ pid: child, command }];
    return [...self, ...runningDescendants(child)];
  });
}

/** Processes started since this worker that name one of `directories`. */
export function processesNaming(directories: ReadonlySet<string>): RunningProcess[] {
  if (directories.size === 0) return [];
  const since = startTime(process.pid);
  return readdirSync("/proc").flatMap((entry) => {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid || startTime(pid) < since) return [];
    const command = commandOf(pid);
    if (command === "") return [];
    let cwd = "";
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // Another user's process, or one that is gone.
    }
    // A removed directory reads as "<path> (deleted)"; separators keep /tmp/a-1 from naming /tmp/a-12.
    const named = `${command}\0${cwd}\0${readProcFile(`/proc/${pid}/environ`)}\0`;
    return [...directories].some((directory) =>
      ["/", ":", " ", "\0"].some((end) => named.includes(`${directory}${end}`)),
    )
      ? [{ pid, command }]
      : [];
  });
}

/**
 * The command line of `pid`, or "" for one that no longer runs: a process that is exiting has
 * already released its memory and with it its command line, and a zombie waits only for its
 * parent to read its status.
 */
function commandOf(pid: number): string {
  return readProcFile(`/proc/${pid}/cmdline`).replaceAll("\0", " ").trim();
}

/** When `pid` started, in clock ticks since boot; Infinity for one that is gone. */
function startTime(pid: number): number {
  const fields = readProcFile(`/proc/${pid}/stat`).split(") ")[1]?.split(" ");
  return fields === undefined ? Number.POSITIVE_INFINITY : Number(fields[19]);
}

/** The children of every thread of `pid`; a process that is gone has none. */
function childrenOf(pid: number): number[] {
  let threads: string[];
  try {
    threads = readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  return threads.flatMap((thread) =>
    readProcFile(`/proc/${pid}/task/${thread}/children`).split(" ").filter(Boolean).map(Number),
  );
}

function readProcFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
