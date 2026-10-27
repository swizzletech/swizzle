// Process identity shared by dev stacks and throwaway packaged stacks. The fingerprint includes
// the working directory and OS start identity, so PID reuse cannot claim a previous owner's work.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";

export type ProcessOwnerState =
  | { readonly kind: "running"; readonly root: string }
  | { readonly kind: "stopped" }
  | { readonly kind: "replaced" };

function fingerprint(root: string, start: string): string {
  return createHash("sha256")
    .update(JSON.stringify([root, start]))
    .digest("hex")
    .slice(0, 32);
}

/** OS start identity includes the boot on Linux, so records cannot match after a reboot. */
export function readProcessIdentity(
  pid: number,
): { root: string; incarnation: string } | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return undefined;
      const start = fields[19];
      if (start === undefined) throw new Error(`Cannot read process start time for ${pid}`);
      const root = readlinkSync(`/proc/${pid}/cwd`);
      const startIdentity = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
      return { root, incarnation: fingerprint(root, startIdentity) };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ESRCH")
      )
        return undefined;
      throw error;
    }
  }
  if (process.platform === "darwin") {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return undefined;
      throw error;
    }
    const incarnation = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    const cwd = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
    });
    const root = cwd
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    if (!root || !incarnation) throw new Error(`Cannot establish ownership of pid ${pid}`);
    return { root, incarnation: fingerprint(root, incarnation) };
  }
  throw new Error(`Stack process ownership is unsupported on ${process.platform}`);
}

/** Verifies the recorded incarnation against the current OS process before a caller acts. */
export function processOwnerState(owner: {
  readonly pid: number;
  readonly incarnation: string;
}): ProcessOwnerState {
  const current = readProcessIdentity(owner.pid);
  if (current === undefined) return { kind: "stopped" };
  return current.incarnation === owner.incarnation
    ? { kind: "running", root: current.root }
    : { kind: "replaced" };
}
