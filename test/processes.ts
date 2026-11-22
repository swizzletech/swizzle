import { readdirSync, readFileSync, readlinkSync } from "node:fs";

interface RunningProcess {
  readonly pid: number;
  readonly command: string;
}

export function killLeftProcesses(
  directories: ReadonlySet<string>,
  suspects: readonly string[],
): void {
  if (process.platform !== "linux") return;
  const running = new Map<number, string>();
  for (const { pid, command } of [
    ...runningDescendants(process.pid),
    ...processesNaming(directories),
  ]) {
    if (!/\/esbuild --service=/u.test(command)) running.set(pid, command);
  }
  if (running.size === 0) return;
  for (const pid of running.keys()) tryKillLeakedProcess(pid);
  throw new Error(
    `${suspectsOf(suspects)}, or an earlier test in this file that timed out, left ${running.size} processes running, now killed:\n${[
      ...running,
    ]
      .map(([pid, command]) => `  ${pid} ${command}`)
      .join("\n")}`,
  );
}

function suspectsOf(suspects: readonly string[]): string {
  if (suspects.length <= 1) return "This test";
  return `One of the concurrent tests ${suspects.map((name) => `"${name}"`).join(", ")}`;
}

function tryKillLeakedProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}

function runningDescendants(pid: number): RunningProcess[] {
  return childrenOf(pid).flatMap((child) => {
    const command = commandOf(child);
    const self = command === "" ? [] : [{ pid: child, command }];
    return [...self, ...runningDescendants(child)];
  });
}

export function processesNaming(directories: ReadonlySet<string>): RunningProcess[] {
  if (directories.size === 0) return [];
  const since = startTime(process.pid);
  return readdirSync("/proc").flatMap((entry) => {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid || startTime(pid) < since) return [];
    const command = commandOf(pid);
    if (command === "") return [];
    const named = `${command}\0${readProcCwdOrEmpty(pid)}\0${readProcFile(`/proc/${pid}/environ`)}\0`;
    return [...directories].some((directory) =>
      ["/", ":", " ", "\0"].some((end) => named.includes(`${directory}${end}`)),
    )
      ? [{ pid, command }]
      : [];
  });
}

function readProcCwdOrEmpty(pid: number): string {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

function commandOf(pid: number): string {
  return readProcFile(`/proc/${pid}/cmdline`).replaceAll("\0", " ").trim();
}

function startTime(pid: number): number {
  const fields = readProcFile(`/proc/${pid}/stat`).split(") ")[1]?.split(" ");
  return fields === undefined ? Number.POSITIVE_INFINITY : Number(fields[19]);
}

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
