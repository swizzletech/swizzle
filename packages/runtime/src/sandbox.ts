// Sandbox containers: the hardened, single-use container each deployed run executes in (ADR 0006),
// and the standby a worker keeps started for the next run of a deployment.
//
// A sandbox is created and started with a hold process before anything runs in it. The run then
// stages its inputs and starts the automation with one `docker exec`, which also carries every
// run-specific value: secrets, run metadata and the egress settings. So nothing in a sandbox
// depends on the run until a run claims it, and a standby made before the run is as fresh as one
// made for it. One run uses a sandbox, then it is removed. Its tmpfs mounts go with it.
//
// Every sandbox is created with --rm and a hold process that ends after its lifetime, so the
// daemon removes it even when the worker that made it is gone. Its worker label lets the next
// start of that worker remove it sooner (`removeLeftoverContainers`).
import { randomUUID } from "node:crypto";
import path from "node:path";

import { EgressProxyConfigurationError, parseEgressProxyUrl } from "@swizzle/core";

import { containerLimitArguments } from "./container-limits.js";
import { DockerScope, sandboxProcessLabel, stackLabel, workerLabel } from "./docker-cli.js";
import { AutomationRuntimeError } from "./errors.js";
import type { AutomationDefinition } from "./validation.js";

const DEFAULT_RUNNER_NETWORK = "swizzle-runner-egress";
const DEFAULT_EGRESS_PROXY = "http://runner-egress-proxy:3128";
export const SANDBOX_USER = "65532:65532";
/** How long a standby waits for a run before it is removed. */
const STANDBY_IDLE_MS = 10 * 60 * 1_000;

/** What every sandbox of one deployment shares: the image and the run-independent create arguments. */
export interface SandboxSpec {
  /** Identifies equal specs, so a standby serves only runs it was made for. */
  readonly key: string;
  readonly image: string;
  readonly createArguments: readonly string[];
  readonly language: "node" | "python" | "typescript";
}

/** A started container that no run has used, until the one run that claims it. */
export interface Sandbox {
  readonly name: string;
  readonly docker: DockerScope;
  /** When its hold process ends and the daemon removes it. */
  readonly expiresAt: number;
  /** Whether it was made before the run asked for it. */
  readonly standby: boolean;
}

interface Standby {
  readonly sandbox: Promise<Sandbox>;
  readonly expiry: NodeJS.Timeout;
}

const standbys = new Map<string, Standby>();
const removals = new Set<Promise<void>>();
let closed = false;

export function sandboxSpec(definition: AutomationDefinition, image: string): SandboxSpec {
  const runtime = definition.config.runtime;
  const language = runtime.language;
  if (language === undefined) {
    throw new AutomationRuntimeError(
      "LANGUAGE_RUNTIME_UNAVAILABLE",
      "runtime.language is required for container execution.",
    );
  }
  const createArguments = [
    "--read-only",
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    ...containerLimitArguments(runtime),
    "--user",
    SANDBOX_USER,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
    "--tmpfs",
    "/home/swizzle:rw,nosuid,nodev,size=256m,mode=0700,uid=65532,gid=65532",
    "--tmpfs",
    "/run/swizzle:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65532,gid=65532",
    "--network",
    runtime.permissions.network ? resolveRunnerNetwork() : "none",
    ...writableDirectoryArguments(runtime.permissions.writable_dirs),
  ];
  return { createArguments, image, key: JSON.stringify([image, createArguments]), language };
}

/**
 * A sandbox that lives at least `lifetimeMs`: the spec's standby when one is ready or starting,
 * otherwise a new one. With `replace`, a new standby starts for the next run once this one has
 * its sandbox.
 */
export async function claimSandbox(
  spec: SandboxSpec,
  input: { readonly lifetimeMs: number; readonly replace: boolean },
): Promise<Sandbox> {
  const standby = await takeStandby(spec, input.lifetimeMs);
  const sandbox = standby ?? (await startSandbox(spec, input.lifetimeMs, false));
  // A replacement that fails to start costs only the next run, which then starts its own sandbox.
  if (input.replace) prewarmSandbox(spec, input.lifetimeMs).catch(() => undefined);
  return sandbox;
}

/**
 * Starts the spec's standby unless it has one, and resolves once it has started. It waits
 * STANDBY_IDLE_MS for a run, and lives long enough to serve a run of `runLifetimeMs` claimed at the
 * end of that wait.
 */
export async function prewarmSandbox(spec: SandboxSpec, runLifetimeMs: number): Promise<void> {
  if (closed) return;
  const existing = standbys.get(spec.key);
  if (existing !== undefined) {
    await existing.sandbox;
    return;
  }
  const sandbox = startSandbox(spec, STANDBY_IDLE_MS + runLifetimeMs, true);
  const entry: Standby = {
    expiry: setTimeout(() => {
      if (standbys.get(spec.key) !== entry) return;
      standbys.delete(spec.key);
      void sandbox.then(discardSandbox, () => undefined);
    }, STANDBY_IDLE_MS).unref(),
    sandbox,
  };
  standbys.set(spec.key, entry);
  sandbox.catch(() => {
    if (standbys.get(spec.key) !== entry) return;
    clearTimeout(entry.expiry);
    standbys.delete(spec.key);
  });
  await sandbox;
}

/** Removes a used sandbox in the background; closeSandboxes waits for it. */
export function discardSandbox(sandbox: Sandbox): void {
  const removal = sandbox.docker.close();
  removals.add(removal);
  void removal.finally(() => removals.delete(removal));
}

/** Removes every standby, waits for pending removals, and makes no new standby after. */
export async function closeSandboxes(): Promise<void> {
  closed = true;
  const pending = [...standbys.values()];
  standbys.clear();
  for (const { expiry } of pending) clearTimeout(expiry);
  await Promise.all(pending.map(({ sandbox }) => sandbox.then(discardSandbox, () => undefined)));
  await sandboxRemovals();
}

/** Resolves once every sandbox removal started so far has ended, retries included. */
export async function sandboxRemovals(): Promise<void> {
  await Promise.all(removals);
}

/** The run network sandboxes and image assembly join; its only way out is the egress proxy. */
export function resolveRunnerNetwork(): string {
  return process.env.SWIZZLE_RUNNER_NETWORK?.trim() || DEFAULT_RUNNER_NETWORK;
}

/** HTTP proxy variables for tools that honour them, such as npm and pip during installs. */
export function egressProxyEnvironment(): Record<string, string> {
  const proxy = process.env.SWIZZLE_RUNNER_EGRESS_PROXY?.trim() || DEFAULT_EGRESS_PROXY;
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: "127.0.0.1,localhost,::1",
    http_proxy: proxy,
    https_proxy: proxy,
    no_proxy: "127.0.0.1,localhost,::1",
  };
}

/**
 * The egress settings of a run. The managed runner's entrypoint routes every TCP connection
 * through the proxy and needs only its address; a custom base image gets the HTTP proxy variables.
 */
export function runEgressEnvironment(definition: AutomationDefinition): Record<string, string> {
  if (!usesManagedRunner(definition)) return egressProxyEnvironment();
  let proxy: URL;
  try {
    proxy = parseEgressProxyUrl(
      "SWIZZLE_RUNNER_EGRESS_PROXY",
      process.env.SWIZZLE_RUNNER_EGRESS_PROXY?.trim() || DEFAULT_EGRESS_PROXY,
    );
  } catch (error) {
    if (!(error instanceof EgressProxyConfigurationError)) throw error;
    throw new AutomationRuntimeError("AUTOMATION_CONFIG_INVALID", error.message);
  }
  return { SWIZZLE_EGRESS_PROXY: `${proxy.hostname}:${proxy.port || "80"}` };
}

/** Whether the run image starts from the stack's managed runner base, with its entrypoint. */
export function usesManagedRunner(definition: AutomationDefinition): boolean {
  return (
    definition.config.runtime.container?.base_image === undefined &&
    Boolean(process.env.SWIZZLE_RUNNER_BASE_IMAGE?.trim())
  );
}

async function takeStandby(spec: SandboxSpec, lifetimeMs: number): Promise<Sandbox | null> {
  const entry = standbys.get(spec.key);
  if (entry === undefined) return null;
  standbys.delete(spec.key);
  clearTimeout(entry.expiry);
  const sandbox = await entry.sandbox;
  if (sandbox.expiresAt - Date.now() >= lifetimeMs) return sandbox;
  discardSandbox(sandbox);
  return null;
}

async function startSandbox(
  spec: SandboxSpec,
  lifetimeMs: number,
  standby: boolean,
): Promise<Sandbox> {
  const name = `swizzle-run-${randomUUID()}`;
  const docker = new DockerScope({ timeoutMs: lifetimeMs, containerName: name });
  const expiresAt = Date.now() + lifetimeMs;
  const [entrypoint = "", ...args] = holdCommand(spec.language, Math.ceil(lifetimeMs / 1_000));
  try {
    await docker.run(
      [
        "create",
        "--name",
        name,
        "--rm",
        "--label",
        stackLabel(),
        "--label",
        workerLabel(),
        "--label",
        sandboxProcessLabel(),
        ...spec.createArguments,
        "--entrypoint",
        entrypoint,
        spec.image,
        ...args,
      ],
      { outputLimitBytes: 256 * 1_024 },
    );
    await docker.run(["start", name], { outputLimitBytes: 256 * 1_024 });
  } catch (error) {
    // --rm removes a container once it stops, but not one that never started.
    await docker.close();
    throw error;
  }
  return { docker, expiresAt, name, standby };
}

/**
 * A process that keeps the sandbox up for `seconds` with the runtime the image already has. The run
 * is a `docker exec`, not its child, so on SIGTERM from `docker stop` it passes the signal on to
 * every other process in the sandbox, and the run gets its grace period before the stop kills it.
 */
function holdCommand(language: SandboxSpec["language"], seconds: number): string[] {
  // One Node timer waits at most 2^31 - 1 ms, so the hold waits in steps until its end.
  return language === "python"
    ? [
        "python3",
        "-c",
        `import os, signal, time; signal.signal(signal.SIGTERM, lambda *_: os.kill(-1, signal.SIGTERM)); time.sleep(${seconds})`,
      ]
    : [
        "node",
        "-e",
        `process.on("SIGTERM", () => process.kill(-1, "SIGTERM")); const end = Date.now() + ${seconds * 1_000}; (function hold() { const left = end - Date.now(); if (left > 0) setTimeout(hold, Math.min(left, 2147483647)); })();`,
      ];
}

function writableDirectoryArguments(directories: readonly string[]): string[] {
  const seen = new Set(["/tmp"]);
  const result: string[] = [];
  for (const configuredDirectory of directories) {
    const directory = path.posix.isAbsolute(configuredDirectory)
      ? configuredDirectory
      : path.posix.join("/automation", configuredDirectory);
    if (seen.has(directory)) continue;
    seen.add(directory);
    result.push("--tmpfs", `${directory}:rw,noexec,nosuid,nodev,size=64m,mode=1777`);
  }
  return result;
}
