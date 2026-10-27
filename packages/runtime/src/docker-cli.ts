// Scoped Docker operations for the sandbox modules. Commands and image usage requests use the
// CLI's daemon connection with only the environment it needs (DOCKER_HOST, the broker in Compose).

import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { hostname } from "node:os";
import { Duplex, Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { BoundedOutput } from "./bounded-output.js";

import { AutomationRuntimeError, getErrorMessage } from "./errors.js";

export interface DockerOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

// The default deployment stack. Trusted local runs add their own namespace below.
const DEFAULT_STACK = "local";
const localStack = new AsyncLocalStorage<string>();

/** Local cleanup cannot touch the deployed images of the configured stack. */
export async function withLocalDockerStack<T>(run: () => Promise<T>): Promise<T> {
  return await localStack.run(`local-${process.env.SWIZZLE_STACK?.trim() || DEFAULT_STACK}`, run);
}
const REMOVE_ATTEMPTS = 3;
const REMOVE_RETRY_MS = 1_000;

/** Deadline for daemon metadata and sandbox control commands. */
const CONTROL_TIMEOUT_MS = 5_000;
/** Copying source and exporting image layers depend on their size and the daemon's storage. */
const TRANSFER_TIMEOUT_MS = 60_000;
const scopes = new Set<DockerScope>();
const PROCESS_LABEL = "swizzle.sandbox-process";
const processId = randomUUID();

/** Sandboxes of this worker process, distinct even when local processes share a hostname. */
export function sandboxProcessLabel(): string {
  return `${PROCESS_LABEL}=${processId}`;
}
let closed = false;

interface DockerOutputOptions {
  readonly onStderrChunk?: (chunk: string) => void;
  readonly onStdoutChunk?: (chunk: string) => void;
  readonly outputLimitBytes: number;
}

/** Owns Docker subprocesses and, when named, their container until close completes cleanup. */
export class DockerScope {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly commands = new Set<Promise<unknown>>();
  private image: string | null = null;
  private container: string | null;
  private closing: Promise<void> | undefined;

  constructor(input: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly containerName: string | null;
  }) {
    if (closed) {
      throw new AutomationRuntimeError("CONTAINER_RUNTIME_UNAVAILABLE", "Docker is shutting down.");
    }
    this.signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(input.timeoutMs),
      ...(input.signal === undefined ? [] : [input.signal]),
    ]);
    this.container = input.containerName;
    scopes.add(this);
  }

  run(args: readonly string[], options: DockerOutputOptions): Promise<DockerOutcome> {
    return this.command(
      args,
      options,
      AbortSignal.any([
        this.signal,
        AbortSignal.timeout(
          args[0] === "cp" || args[0] === "commit" ? TRANSFER_TIMEOUT_MS : CONTROL_TIMEOUT_MS,
        ),
      ]),
    );
  }

  /** Sharing among these references, or all stack images for null, on the CLI's selected engine. */
  imageUsage(references: readonly string[] | null): Promise<unknown> {
    const query = new URLSearchParams({
      all: "true",
      "shared-size": "true",
      filters: JSON.stringify({
        label: [stackLabel()],
        ...(references === null ? {} : { reference: references }),
      }),
    });
    return this.track(
      dockerJson(
        `/images/json?${query}`,
        AbortSignal.any([this.signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]),
      ),
    );
  }

  /** Protects a create that is still owned while reconciliation lists Created containers. */
  ownsContainer(name: string): boolean {
    return this.container === name;
  }

  /** Attached installation is execution, bounded by the assembly owner's deadline. */
  attachInstall(name: string, options: DockerOutputOptions): Promise<DockerOutcome> {
    return this.command(["start", "--attach", name], options, this.signal);
  }

  /** A committed image is rolled back unless tagging succeeds and the caller retains it. */
  ownImage(image: string): void {
    this.image = image;
  }

  retainImage(): void {
    this.image = null;
  }

  /** The named container turned out to be another process's: close leaves it in place. */
  releaseContainer(): void {
    this.container = null;
  }

  close(): Promise<void> {
    this.closing ??= this.cleanup();
    return this.closing;
  }

  private command(
    args: readonly string[],
    options: DockerOutputOptions,
    signal: AbortSignal,
  ): Promise<DockerOutcome> {
    return this.track(runDocker(args, options, signal));
  }

  private track<T>(command: Promise<T>): Promise<T> {
    this.commands.add(command);
    void command.then(
      () => this.commands.delete(command),
      () => this.commands.delete(command),
    );
    return command;
  }

  private async cleanup(): Promise<void> {
    this.controller.abort(new Error("Docker owner closed."));
    await Promise.allSettled(this.commands);
    try {
      await Promise.all([
        this.container === null ? undefined : removeContainer(this.container),
        this.image === null
          ? undefined
          : runDocker(
              ["image", "rm", this.image],
              { outputLimitBytes: 4096 },
              AbortSignal.timeout(CONTROL_TIMEOUT_MS),
            ).catch(() => undefined),
      ]);
    } finally {
      scopes.delete(this);
    }
  }
}

/** Worker shutdown owns all remaining scopes, including shared image assembly and cleanup. */
export async function closeDockerScopes(): Promise<void> {
  closed = true;
  await Promise.all([...scopes].map((scope) => scope.close()));
}

/** Owns the CLI group and output pipes, so descendants cannot hold a deadline open. */
async function runDocker(
  args: readonly string[],
  options: DockerOutputOptions,
  signal: AbortSignal,
): Promise<DockerOutcome> {
  if (signal.aborted) throw dockerAbortError(args, signal);
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], {
      detached: process.platform !== "win32",
      env: dockerCliEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new BoundedOutput(options.outputLimitBytes);
    const stderr = new BoundedOutput(options.outputLimitBytes);
    let callbackFailure: { readonly error: unknown } | undefined;
    const abort = () => killDockerProcess(child);
    const deliver = (callback: ((chunk: string) => void) | undefined, chunk: string) => {
      if (callbackFailure !== undefined) return;
      try {
        callback?.(chunk);
      } catch (error) {
        callbackFailure = { error };
        killDockerProcess(child);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.append(chunk);
      deliver(options.onStdoutChunk, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.append(chunk);
      deliver(options.onStderrChunk, chunk);
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(
        new AutomationRuntimeError(
          "CONTAINER_RUNTIME_UNAVAILABLE",
          `Docker CLI is unavailable: ${getErrorMessage(error)}`,
          { cause: error },
        ),
      );
    });
    child.once("close", (exitCode, exitSignal) => {
      signal.removeEventListener("abort", abort);
      if (callbackFailure !== undefined) {
        reject(callbackFailure.error);
      } else if (signal.aborted) {
        reject(dockerAbortError(args, signal));
      } else if (exitCode === 0)
        resolve({ exitCode, signal: exitSignal, stderr: stderr.value, stdout: stdout.value });
      else
        reject(
          new Error(
            `docker ${args[0] ?? "command"} failed (${exitCode ?? exitSignal}): ${stderr.value.trim().slice(-4096)}`,
          ),
        );
    });
  });
}

/** Uses Node's HTTP framing over the CLI connection, so contexts and the broker work alike. */
async function dockerJson(path: string, signal: AbortSignal): Promise<unknown> {
  const args = ["system", "dial-stdio"];
  if (signal.aborted) throw dockerAbortError(args, signal);
  const child = spawn("docker", args, {
    detached: process.platform !== "win32",
    env: dockerCliEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const socket = Duplex.fromWeb({
    readable: Readable.toWeb(child.stdout),
    writable: Writable.toWeb(child.stdin),
  });
  const stderr = new BoundedOutput(4096);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr.append(chunk);
  });
  const client = request({
    method: "GET",
    host: "docker",
    path,
    headers: { connection: "close" },
    createConnection: () => socket,
  });
  const abort = () => client.destroy(dockerAbortError(args, signal));
  signal.addEventListener("abort", abort, { once: true });
  child.once("error", (error) =>
    client.destroy(
      new AutomationRuntimeError(
        "CONTAINER_RUNTIME_UNAVAILABLE",
        `Docker CLI is unavailable: ${getErrorMessage(error)}`,
        { cause: error },
      ),
    ),
  );
  child.once("close", (code) => {
    if (!client.destroyed)
      client.destroy(
        new Error(`Docker image usage connection closed (${code}): ${stderr.value.trim()}`),
      );
  });
  try {
    return await new Promise((resolve, reject) => {
      client.on("error", reject);
      client.on("response", (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Cannot measure shared disk use (HTTP ${response.statusCode}).`));
          return;
        }
        let body = "";
        let bytes = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 1_048_576) response.destroy(new Error("Docker image usage exceeds 1 MiB."));
          else body += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      });
      if (signal.aborted) abort();
      client.end();
    });
  } finally {
    signal.removeEventListener("abort", abort);
    client.destroy();
    socket.destroy();
    killDockerProcess(child);
    await exited;
  }
}

/**
 * Kills a Docker CLI spawned with `detached` on POSIX, its whole process group, and closes its
 * pipes: a helper can leave the group and still inherit one. The CLI's `close` then follows.
 */
export function killDockerProcess(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    } else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function dockerAbortError(args: readonly string[], signal: AbortSignal): AutomationRuntimeError {
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  return new AutomationRuntimeError(
    timeout ? "DOCKER_CONTROL_TIMEOUT" : "CONTAINER_RUNTIME_UNAVAILABLE",
    `docker ${args[0] ?? "command"} stopped: ${timeout ? "DOCKER_CONTROL_TIMEOUT: Docker deadline exceeded" : getErrorMessage(signal.reason)}`,
  );
}

/** Cleanup has its own deadlines, independent of the expired or cancelled owner. */
async function removeContainer(name: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runDocker(
        ["rm", "--force", name],
        { outputLimitBytes: 4096 },
        AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      );
      return;
    } catch (error) {
      if (/no such container/iu.test(getErrorMessage(error))) return;
      if (attempt === REMOVE_ATTEMPTS) return;
      await delay(REMOVE_RETRY_MS);
    }
  }
}

/** Removes Created sandboxes this process no longer owns, including creates that finished late. */
export async function removeAbandonedContainers(): Promise<void> {
  const listed = await runDocker(
    [
      "ps",
      "--all",
      "--filter",
      `label=${stackLabel()}`,
      "--format",
      `{{.Names}} {{.State}} {{.Label "${PROCESS_LABEL}"}}`,
    ],
    { outputLimitBytes: 1_048_576 },
    AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  );
  for (const line of listed.stdout.split("\n")) {
    const [name = "", state, owner] = line.trim().split(" ");
    if (
      state === "created" &&
      owner === processId &&
      name.startsWith("swizzle-run-") &&
      ![...scopes].some((scope) => scope.ownsContainer(name))
    )
      await removeContainer(name);
  }
}

/**
 * The label on every container and runner image this process makes, naming its stack
 * (SWIZZLE_STACK, the compose project in the Compose stack). Stacks on one host share the Docker
 * daemon, so the label keeps each stack's prune to its own images and gives each stack its own
 * image tags. In the Compose stack the Docker broker acts only on containers and images with it.
 */
export function stackLabel(): string {
  return `swizzle.stack=${stackName()}`;
}

function stackName(): string {
  const stack = localStack.getStore() ?? (process.env.SWIZZLE_STACK?.trim() || DEFAULT_STACK);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(stack)) {
    throw new AutomationRuntimeError(
      "CONTAINER_RUNTIME_UNAVAILABLE",
      "SWIZZLE_STACK must be a compose project name: lowercase letters, digits, dashes and underscores.",
    );
  }
  return stack;
}

/**
 * The label on every container this process makes, naming the worker that made it by its hostname:
 * in the Compose stack, Docker's short id of the worker container. A worker container that starts
 * again removes the containers it left and those of worker containers that no longer run, and
 * keeps a live replica's (`removeLeftoverContainers`).
 */
export function workerLabel(): string {
  return `${WORKER_LABEL}=${hostname()}`;
}

const WORKER_LABEL = "swizzle.worker";
/** Compose puts it on each worker container of the stack (infra/docker/execution.yml). */
const WORKER_OF_LABEL = "swizzle.worker-of";

/**
 * Removes the sandboxes and image assemblies of this stack that a stopped or killed worker left:
 * those this worker's container made before it restarted, and those of worker containers that no
 * longer run. A run's sandbox outlives a killed worker until its hold process ends, which can be
 * an hour. Call it at worker start, before the process makes a container. Resolves the count removed.
 */
export async function removeLeftoverContainers(): Promise<number> {
  const list = async (label: string, format: string, all: boolean) =>
    (
      await runDocker(
        ["ps", ...(all ? ["--all"] : []), "--filter", `label=${label}`, "--format", format],
        { outputLimitBytes: 1_048_576 },
        AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      )
    ).stdout
      .split("\n")
      .filter((line) => line.trim() !== "");
  // Containers first, live workers second: a replica that starts in between and makes a sandbox
  // is then live in the second list, so its sandbox is never taken for a gone worker's.
  const made = await list(stackLabel(), `{{.ID}} {{.Label "${WORKER_LABEL}"}}`, true);
  const live = await list(`${WORKER_OF_LABEL}=${stackName()}`, "{{.ID}}", false);
  const containers = made.map((line) => {
    const [id = "", owner = ""] = line.trim().split(" ");
    return { id, owner };
  });
  const leftovers = leftoverContainers(containers, new Set(live), hostname());
  await Promise.all(leftovers.map(removeContainer));
  return leftovers.length;
}

/**
 * Which of the stack's containers are left over: made by `self` before it restarted, made by a
 * worker that is not among the `live` ones, or made without an owner label. Only a worker that is
 * itself one of the `live` containers decides: worker processes on one host share a hostname and
 * tell no one whether they run, so a worker outside the Compose stack removes nothing.
 */
export function leftoverContainers(
  containers: readonly { readonly id: string; readonly owner: string }[],
  live: ReadonlySet<string>,
  self: string,
): readonly string[] {
  if (!live.has(self)) return [];
  return containers.filter(({ owner }) => owner === self || !live.has(owner)).map(({ id }) => id);
}

export function dockerCliEnvironment(): NodeJS.ProcessEnv {
  return {
    DOCKER_HOST: process.env.DOCKER_HOST,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
  };
}
