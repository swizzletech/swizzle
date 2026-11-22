import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AutomationRuntimeError, getErrorMessage } from "./errors.js";
import { OutputPump, type StdoutOutput } from "./output-pump.js";

export interface DockerOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

const DEFAULT_STACK = "local";
const localStack = new AsyncLocalStorage<string>();

export async function withLocalDockerStack<T>(run: () => Promise<T>): Promise<T> {
  return await localStack.run(`local-${process.env.SWIZZLE_STACK?.trim() || DEFAULT_STACK}`, run);
}
const REMOVE_ATTEMPTS = 3;
const REMOVE_RETRY_MS = 1_000;

export const DOCKER_DEADLINES = { control: 5_000, transfer: 60_000 } as const;
type CommandDeadline = keyof typeof DOCKER_DEADLINES;
type DeadlineKind = CommandDeadline | "assembly";

interface Deadline {
  readonly kind: DeadlineKind;
  readonly signal: AbortSignal;
}

export class DockerDeadlineError extends AutomationRuntimeError {
  constructor(
    readonly kind: DeadlineKind,
    command: string,
  ) {
    const code =
      kind === "transfer"
        ? "DOCKER_TRANSFER_TIMEOUT"
        : kind === "control"
          ? "DOCKER_CONTROL_TIMEOUT"
          : "CONTAINER_RUNTIME_UNAVAILABLE";
    super(
      code,
      `docker ${command} stopped: ${kind === "assembly" ? "Docker assembly deadline exceeded" : `${code}: Docker deadline exceeded`}`,
    );
  }
}

function commandDeadline(kind: CommandDeadline): Deadline {
  return { kind, signal: AbortSignal.timeout(DOCKER_DEADLINES[kind]) };
}

const scopes = new Set<DockerScope>();
const PROCESS_LABEL = "swizzle.sandbox-process";
const processId = randomUUID();

export function sandboxProcessLabel(): string {
  return `${PROCESS_LABEL}=${processId}`;
}
let closed = false;

interface DockerOutputOptions {
  readonly onStderrChunk?: (chunk: string) => void;
  readonly outputLimitBytes: number;
  readonly stdout?: StdoutOutput;
}

export class DockerScope {
  readonly signal: AbortSignal;
  private readonly ownerDeadline: AbortSignal;
  private readonly ownerDeadlineKind: "assembly" | undefined;
  private readonly controller = new AbortController();
  private readonly commands = new Set<Promise<unknown>>();
  private image: string | null = null;
  private container: string | null;
  private closing: Promise<void> | undefined;

  constructor(input: {
    readonly timeoutMs: number;
    readonly deadlineKind?: "assembly";
    readonly signal?: AbortSignal;
    readonly containerName: string | null;
  }) {
    if (closed) {
      throw new AutomationRuntimeError("CONTAINER_RUNTIME_UNAVAILABLE", "Docker is shutting down.");
    }
    this.ownerDeadlineKind = input.deadlineKind;
    this.ownerDeadline = AbortSignal.timeout(input.timeoutMs);
    this.signal = AbortSignal.any([
      this.controller.signal,
      this.ownerDeadline,
      ...(input.signal === undefined ? [] : [input.signal]),
    ]);
    this.container = input.containerName;
    scopes.add(this);
  }

  static async removals(): Promise<void> {
    await Promise.all([...scopes].map((scope) => scope.closing));
  }

  run(
    args: readonly string[],
    options: DockerOutputOptions & { readonly deadline?: CommandDeadline },
  ): Promise<DockerOutcome> {
    const kind = options.deadline ?? (args[0] === "create" ? "transfer" : "control");
    return this.track(
      runDocker(
        args,
        options,
        [
          { kind: this.ownerDeadlineKind ?? kind, signal: this.ownerDeadline },
          commandDeadline(kind),
        ],
        this.signal,
      ),
    );
  }

  ownsContainer(name: string): boolean {
    return this.container === name;
  }

  attachInstall(name: string, options: DockerOutputOptions): Promise<DockerOutcome> {
    return this.track(
      runDocker(
        ["start", "--attach", name],
        options,
        [{ kind: "assembly", signal: this.ownerDeadline }],
        this.signal,
      ),
    );
  }

  ownImage(image: string): void {
    this.image = image;
  }

  retainImage(): void {
    this.image = null;
  }

  releaseContainer(): void {
    this.container = null;
  }

  close(): Promise<void> {
    this.closing ??= this.cleanup();
    return this.closing;
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
          : runDocker(["image", "rm", this.image], { outputLimitBytes: 4096 }, [
              commandDeadline("control"),
            ]).catch(() => undefined),
      ]);
    } finally {
      scopes.delete(this);
    }
  }
}

export async function closeDockerScopes(): Promise<void> {
  closed = true;
  await Promise.all([...scopes].map((scope) => scope.close()));
}

async function runDocker(
  args: readonly string[],
  options: DockerOutputOptions,
  deadlines: readonly Deadline[],
  owner?: AbortSignal,
): Promise<DockerOutcome> {
  const signal = AbortSignal.any([
    ...(owner === undefined ? [] : [owner]),
    ...deadlines.map((deadline) => deadline.signal),
  ]);
  const abortError = () => {
    const command = args[0] ?? "command";
    const deadline = deadlines.find(
      ({ signal: clock }) => clock.aborted && clock.reason === signal.reason,
    );
    return deadline === undefined
      ? new AutomationRuntimeError(
          "CONTAINER_RUNTIME_UNAVAILABLE",
          `docker ${command} stopped: ${getErrorMessage(signal.reason)}`,
        )
      : new DockerDeadlineError(deadline.kind, command);
  };
  if (signal.aborted) throw abortError();
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], {
      detached: process.platform !== "win32",
      env: dockerCliEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = new OutputPump(child, {
      stdout: options.stdout ?? { kind: "text" },
      stdoutLimitBytes: options.outputLimitBytes,
      stderrLimitBytes: options.outputLimitBytes,
      onStderrChunk: options.onStderrChunk,
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
            reject(abortError());
          } else if (output.stoppedByRequest || exitCode === 0)
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

async function removeContainer(name: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runDocker(["rm", "--force", name], { outputLimitBytes: 4096 }, [
        commandDeadline("control"),
      ]);
      return;
    } catch (error) {
      if (/no such container/iu.test(getErrorMessage(error))) return;
      if (attempt === REMOVE_ATTEMPTS) return;
      await delay(REMOVE_RETRY_MS);
    }
  }
}

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
    [commandDeadline("control")],
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

export function workerLabel(): string {
  return `${WORKER_LABEL}=${hostname()}`;
}

const WORKER_LABEL = "swizzle.worker";
const WORKER_OF_LABEL = "swizzle.worker-of";

export async function removeLeftoverContainers(): Promise<number> {
  const list = async (label: string, format: string, all: boolean) =>
    (
      await runDocker(
        ["ps", ...(all ? ["--all"] : []), "--filter", `label=${label}`, "--format", format],
        { outputLimitBytes: 1_048_576 },
        [commandDeadline("control")],
      )
    ).stdout
      .split("\n")
      .filter((line) => line.trim() !== "");
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
