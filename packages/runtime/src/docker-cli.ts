// Scoped Docker operations for the sandbox modules. Commands use the
// CLI's daemon connection with only the environment it needs (DOCKER_HOST, the broker in Compose).

import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AutomationRuntimeError, getErrorMessage } from "./errors.js";
import { OutputPump } from "./output-pump.js";

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
export const CONTROL_TIMEOUT_MS = 5_000;
/** Allocating a container, copying source and exporting layers depend on daemon storage and load. */
export const TRANSFER_TIMEOUT_MS = 60_000;
export type DockerDeadlines = Readonly<{ control: number; transfer: number }>;
export const DOCKER_DEADLINES: DockerDeadlines = {
  control: CONTROL_TIMEOUT_MS,
  transfer: TRANSFER_TIMEOUT_MS,
};
type DockerDeadline = keyof DockerDeadlines;

const scopes = new Set<DockerScope>();
const PROCESS_LABEL = "swizzle.sandbox-process";
const processId = randomUUID();

/** Sandboxes of this worker process, distinct even when local processes share a hostname. */
export function sandboxProcessLabel(): string {
  return `${PROCESS_LABEL}=${processId}`;
}
let closed = false;

type DockerOutputOptions = {
  readonly onStderrChunk?: (chunk: string) => void;
  readonly outputLimitBytes: number;
} & (
  | { readonly onStdoutChunk?: (chunk: string) => void; readonly onStdoutBytes?: never }
  | {
      readonly onStdoutBytes: (chunk: Buffer) => "stop" | undefined;
      readonly onStdoutChunk?: never;
    }
);

/** Owns Docker subprocesses and, when named, their container until close completes cleanup. */
export class DockerScope {
  readonly signal: AbortSignal;
  private readonly deadlines: DockerDeadlines;
  private readonly controller = new AbortController();
  private readonly commands = new Set<Promise<unknown>>();
  private image: string | null = null;
  private container: string | null;
  private closing: Promise<void> | undefined;

  constructor(input: {
    readonly timeoutMs: number;
    readonly deadlines?: DockerDeadlines;
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
    this.deadlines = input.deadlines ?? DOCKER_DEADLINES;
    scopes.add(this);
  }

  /** Waits for cleanup already started, without closing active scopes. */
  static async removals(): Promise<void> {
    await Promise.all([...scopes].map((scope) => scope.closing));
  }

  run(
    args: readonly string[],
    options: DockerOutputOptions & { readonly deadline?: DockerDeadline },
  ): Promise<DockerOutcome> {
    const deadline = options.deadline ?? (args[0] === "create" ? "transfer" : "control");
    return this.command(
      args,
      options,
      AbortSignal.any([this.signal, AbortSignal.timeout(this.deadlines[deadline])]),
      deadline,
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
    deadline: DockerDeadline = "control",
  ): Promise<DockerOutcome> {
    return this.track(runDocker(args, options, signal, deadline));
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
  deadline: DockerDeadline = "control",
): Promise<DockerOutcome> {
  if (signal.aborted) throw dockerAbortError(args, signal, deadline);
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], {
      detached: process.platform !== "win32",
      env: dockerCliEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stopped = false;
    const onStdoutBytes = options.onStdoutBytes;
    const output = new OutputPump({
      stdout: child.stdout,
      stderr: child.stderr,
      stdoutLimitBytes: options.outputLimitBytes,
      stderrLimitBytes: options.outputLimitBytes,
      onStderrChunk: options.onStderrChunk,
      ...(onStdoutBytes === undefined
        ? { onStdoutChunk: options.onStdoutChunk }
        : {
            onStdoutBytes: (chunk: Buffer) => {
              if (onStdoutBytes(chunk) === "stop") {
                stopped = true;
                output.stop();
                killDockerProcess(child);
              }
            },
          }),
      limitPolicy: "capture",
      onStop: () => killDockerProcess(child),
    });
    const abort = () => killDockerProcess(child);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
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
      void output.finished().then(
        () => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            reject(dockerAbortError(args, signal, deadline));
          } else if (stopped || exitCode === 0)
            resolve({ exitCode, signal: exitSignal, stderr: output.stderr, stdout: output.stdout });
          else
            reject(
              new Error(
                `docker ${args[0] ?? "command"} failed (${exitCode ?? exitSignal}): ${output.stderr.trim().slice(-4096)}`,
              ),
            );
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  });
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

function dockerAbortError(
  args: readonly string[],
  signal: AbortSignal,
  deadline: DockerDeadline,
): AutomationRuntimeError {
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  const code = deadline === "transfer" ? "DOCKER_TRANSFER_TIMEOUT" : "DOCKER_CONTROL_TIMEOUT";
  return new AutomationRuntimeError(
    timeout ? code : "CONTAINER_RUNTIME_UNAVAILABLE",
    `docker ${args[0] ?? "command"} stopped: ${timeout ? `${code}: Docker deadline exceeded` : getErrorMessage(signal.reason)}`,
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
