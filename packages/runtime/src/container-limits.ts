// The resources a container that runs automation code may use: the run sandbox, and the install
// step that assembles its run image, where dependency code such as a PEP 517 backend runs too. Both
// take their limits from containerLimitArguments, so the two cannot drift apart. The install
// container's writable layer has its own bound, installDiskLimitMb.
//
// An automation asks for memory and CPUs in runtime.container. The operator caps both with
// SWIZZLE_MAX_RUN_MEMORY_MB and SWIZZLE_MAX_RUN_CPUS: deploy readiness reports a request above the
// cap, and the worker refuses one before it creates a container, so lowering the cap also stops
// existing deployments that exceed it. A cap that is not a positive number is PLATFORM_CONFIG_INVALID,
// which fails the run at once: every retry would read the same setting.
import type { AutomationRuntimeConfig } from "@swizzle/config";

import { AutomationRuntimeError } from "./errors.js";

const DEFAULT_MEMORY_MB = 512;
const DEFAULT_CPUS = "1.0";
const MAX_MEMORY_MB_ENV = "SWIZZLE_MAX_RUN_MEMORY_MB";
const MAX_CPUS_ENV = "SWIZZLE_MAX_RUN_CPUS";
const DEFAULT_MAX_MEMORY_MB = 2048;
const DEFAULT_MAX_CPUS = 2;
const MAX_INSTALL_DISK_MB_ENV = "SWIZZLE_MAX_INSTALL_DISK_MB";
const DEFAULT_MAX_INSTALL_DISK_MB = 4096;

export interface ContainerLimitIssue {
  readonly message: string;
  readonly subject: "runtime.container.cpus" | "runtime.container.memory_mb";
}

/** The automation's requested limits that exceed the platform maximum; empty when all fit. */
export function containerLimitIssues(
  runtime: Pick<AutomationRuntimeConfig, "container">,
  environment: NodeJS.ProcessEnv = process.env,
): ContainerLimitIssue[] {
  const { cpus, memoryMb } = requestedLimits(runtime);
  const maxMemoryMb = platformMaximum(environment, MAX_MEMORY_MB_ENV, DEFAULT_MAX_MEMORY_MB);
  const maxCpus = platformMaximum(environment, MAX_CPUS_ENV, DEFAULT_MAX_CPUS);
  const issues: ContainerLimitIssue[] = [];
  if (memoryMb > maxMemoryMb) {
    issues.push({
      message: `runtime.container.memory_mb ${memoryMb} exceeds the platform maximum of ${maxMemoryMb} MiB set by ${MAX_MEMORY_MB_ENV}.`,
      subject: "runtime.container.memory_mb",
    });
  }
  if (Number(cpus) > maxCpus) {
    issues.push({
      message: `runtime.container.cpus ${cpus} exceeds the platform maximum of ${maxCpus} CPUs set by ${MAX_CPUS_ENV}.`,
      subject: "runtime.container.cpus",
    });
  }
  return issues;
}

/**
 * The `docker create` arguments that bound a container running this automation's code: processes,
 * open files, memory without swap, and CPUs. Throws RUNTIME_CONTAINER_LIMIT_EXCEEDS_MAX when the
 * automation asks for more than the platform maximum.
 *
 * Processes are bounded by the container's PID limit alone. Every sandbox runs as the same user,
 * and RLIMIT_NPROC (`--ulimit nproc`) counts that user's tasks in all containers on the host, so
 * one run holding processes would make every other run's fork fail (f-222).
 */
export function containerLimitArguments(
  runtime: Pick<AutomationRuntimeConfig, "container">,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const issues = containerLimitIssues(runtime, environment);
  if (issues.length > 0) {
    throw new AutomationRuntimeError(
      "RUNTIME_CONTAINER_LIMIT_EXCEEDS_MAX",
      issues.map((issue) => issue.message).join(" "),
    );
  }
  const { cpus, memoryMb } = requestedLimits(runtime);
  return [
    "--pids-limit",
    "128",
    "--ulimit",
    "nofile=1024:1024",
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--cpus",
    cpus,
  ];
}

/**
 * How many MiB the install container's writable layer may hold, the copied source included:
 * SWIZZLE_MAX_INSTALL_DISK_MB, default 4096. The run sandbox writes only to sized tmpfs mounts.
 */
export function installDiskLimitMb(environment: NodeJS.ProcessEnv = process.env): number {
  return platformMaximum(environment, MAX_INSTALL_DISK_MB_ENV, DEFAULT_MAX_INSTALL_DISK_MB);
}

function requestedLimits(runtime: Pick<AutomationRuntimeConfig, "container">) {
  return {
    cpus: runtime.container?.cpus ?? DEFAULT_CPUS,
    memoryMb: runtime.container?.memory_mb ?? DEFAULT_MEMORY_MB,
  };
}

function platformMaximum(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const configured = environment[name]?.trim();
  if (configured === undefined || configured === "") return fallback;
  const value = Number(configured);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AutomationRuntimeError(
      "PLATFORM_CONFIG_INVALID",
      `${name} must be a positive number, not ${JSON.stringify(configured)}.`,
    );
  }
  return value;
}
