// The image a sandboxed run starts from: a runner base, the automation's source in /automation and
// its installed dependencies. The tag names the source, the recipe, the stack and the architecture,
// so a new deployment gets a new image, and an unchanged one reuses it on every worker of the stack
// that shares the Docker engine, also after the worker container is recreated.
//
// The worker assembles the image without `docker build`: it creates a container from the base,
// copies the source in as the sandbox user, runs the recipe's install step in that container on
// the run network under the run sandbox's resource limits, and commits the container. While the
// install step runs, the worker measures the container's writable layer and kills the step once
// the layer passes the install disk limit: no Docker storage option bounds it on every driver.
// `docker build` would be the legacy builder in the worker image, which is slow and deprecated,
// and BuildKit cannot attach an install step to the run network, the only route through the
// egress proxy.

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AutomationRuntimeConfig } from "@swizzle/config";
import type { RunImageDisk } from "@swizzle/db";
import { BoundedOutput } from "./bounded-output.js";

import { containerLimitArguments, installDiskLimitMb } from "./container-limits.js";
import { DockerScope, removeAbandonedContainers, stackLabel, workerLabel } from "./docker-cli.js";
import { AutomationRuntimeError, getErrorMessage } from "./errors.js";
import {
  egressProxyEnvironment,
  resolveRunnerNetwork,
  SANDBOX_USER,
  usesManagedRunner,
} from "./sandbox.js";
import type { AutomationDefinition } from "./validation.js";

const DEFAULT_IMAGE_RETENTION_HOURS = 24;
const DEFAULT_IMAGE_DISK_MB = 20_480;
/** How often a worker prunes images that no live worker's active deployment keeps. */
export const RUN_IMAGE_PRUNE_INTERVAL_MS = 15 * 60 * 1_000;
/** Gives an assembly time to start its sandbox, after which Docker refuses to remove its image. */
const FRESH_IMAGE_MS = 10 * 60 * 1_000;
const RUN_TAG = /^swizzle-run:([0-9a-f]{24})$/u;
const IMAGE_FORMAT = `[{{json .Id}},{{json .Created}},{{.Size}},{{json .RepoTags}},{{json .RootFS.Layers}}]`;
const ASSEMBLY_ATTEMPTS = 2;
/** How long one assembly attempt, the install step included, may take. */
const ASSEMBLY_TIMEOUT_MS = 10 * 60 * 1_000;
/** How often the install step's writable layer is measured against the install disk limit. */
const LAYER_CHECK_INTERVAL_MS = 1_000;
/** Where installed tools live, outside the source; the install step can write only here and in /automation. */
const TOOL_DIRECTORY = "/opt/swizzle";
/** The Node of the runner-base image in infra/docker/Dockerfile; the toolchain-pins convention fails on drift. */
const NODE_BASE_IMAGE = "node:26.12.1-trixie-slim";
const FALLBACK_BASE_IMAGES: Record<AutomationRuntimeConfig["language"], string> = {
  node: NODE_BASE_IMAGE,
  python: "python:3.15.1-slim-trixie",
  typescript: NODE_BASE_IMAGE,
};
const ASSEMBLY_LOG_LIMIT_BYTES = 1_048_576;
interface RunImageAssembly {
  readonly finished: Promise<void>;
  readonly logs: string;
  readonly listeners: Set<(chunk: string) => void>;
}
const assemblies = new Map<string, RunImageAssembly>();

/** How to turn a runner base and an automation's source into its run image. */
export interface RunImageRecipe {
  readonly baseImage: string;
  /** Shell commands that install dependencies as the sandbox user; null when nothing installs. */
  readonly install: string | null;
  /** ENV instructions the image keeps, such as the virtualenv on PATH. */
  readonly environment: readonly string[];
  /** What a run executes in the sandbox. */
  readonly command: readonly string[];
  /** The run sandbox's resource limits, which the install step runs under too. */
  readonly limits: readonly string[];
}

export function runImageRecipe(definition: AutomationDefinition): RunImageRecipe {
  const runtime = definition.config.runtime;
  const language = runtime.language;
  if (language === undefined) {
    throw new AutomationRuntimeError(
      "LANGUAGE_RUNTIME_UNAVAILABLE",
      "runtime.language is required for container execution.",
    );
  }
  const baseImage =
    runtime.container?.base_image ??
    (process.env.SWIZZLE_RUNNER_BASE_IMAGE?.trim() || FALLBACK_BASE_IMAGES[language]);
  if (!isSafeImageReference(baseImage)) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      "runtime.container.base_image must be a single valid container image reference.",
    );
  }
  // Node strips TypeScript types itself, so a .ts entrypoint runs like a .js one: as an ES module
  // when it uses import, export or top-level await, unless its package.json says commonjs.
  const executable = language === "python" ? "python3" : "node";
  const automation = [executable, `/automation/${definition.entrypointRelativePath}`];
  const command = usesManagedRunner(definition)
    ? ["/usr/local/bin/swizzle-entrypoint", ...automation]
    : automation;

  const install: string[] = [];
  const environment: string[] = [];
  if (language === "python") {
    const requirements = runtime.requirements.python?.requirements_file;
    if (requirements !== undefined) {
      install.push(
        `python3 -m venv ${TOOL_DIRECTORY}/venv`,
        `${TOOL_DIRECTORY}/venv/bin/python3 -m pip install --disable-pip-version-check --no-input --no-cache-dir --requirement ${shellQuote(requirements)}`,
      );
      environment.push(
        `VIRTUAL_ENV=${TOOL_DIRECTORY}/venv`,
        `PATH=${TOOL_DIRECTORY}/venv/bin:$PATH`,
      );
    }
  } else {
    const node = runtime.requirements.node;
    if (node !== undefined) {
      if (node.package_json !== "package.json") {
        install.push(`cp ${shellQuote(node.package_json)} package.json`);
      }
      install.push(nodeInstallCommand(node.lockfile));
    }
  }
  return {
    baseImage,
    command,
    environment,
    install: install.length === 0 ? null : install.join(" && "),
    limits: containerLimitArguments(runtime),
  };
}

/**
 * The tag of the run image for this source, recipe, stack and architecture. Worker replicas that
 * share the Docker engine share it too; `ensureRunImage` lets one of them assemble it and never
 * moves a tag that exists, because a moved tag can make the engine drop the image another replica's
 * sandbox is about to start from.
 */
export async function runImageTag(
  automationDirectory: string,
  recipe: RunImageRecipe,
): Promise<string> {
  const digest = createHash("sha256")
    .update(await hashAutomationDirectory(automationDirectory))
    .update("\0")
    .update(JSON.stringify(recipe))
    .update("\0")
    .update(stackLabel())
    .update("\0")
    .update(process.arch)
    .digest("hex");
  return `swizzle-run:${digest.slice(0, 24)}`;
}

/**
 * Makes sure the run image exists: "ready" when it already did, "assembled" when this call
 * assembled it or waited for an assembly in progress.
 */
export async function ensureRunImage(input: {
  readonly automationDirectory: string;
  readonly recipe: RunImageRecipe;
  readonly tag: string;
  readonly onLog?: (chunk: string) => void;
}): Promise<"ready" | "assembled"> {
  if (await imageExists(input.tag)) return "ready";
  let assembly = assemblies.get(input.tag);
  if (assembly === undefined) {
    assembly = startAssembly(input);
    assemblies.set(input.tag, assembly);
  }
  const shared = assembly;
  await new Promise<void>((resolve, reject) => {
    const onLog = (chunk: string) => {
      try {
        input.onLog?.(chunk);
      } catch (error) {
        shared.listeners.delete(onLog);
        reject(error);
      }
    };
    if (input.onLog !== undefined) {
      shared.listeners.add(onLog);
      if (shared.logs !== "") onLog(shared.logs);
    }
    void shared.finished.then(resolve, reject).finally(() => shared.listeners.delete(onLog));
  });
  return "assembled";
}

/** Retains bounded output for later joiners and delivers new output to all current waiters. */
function startAssembly(input: AssemblyInput): RunImageAssembly {
  const logs = new BoundedOutput(ASSEMBLY_LOG_LIMIT_BYTES);
  const listeners = new Set<(chunk: string) => void>();
  const finished = assembleRunImage({
    ...input,
    onLog: (chunk) => {
      const accepted = logs.append(chunk);
      for (const listener of listeners) listener(accepted);
      if (logs.exceeded) {
        throw new AutomationRuntimeError(
          "PROCESS_OUTPUT_LIMIT_EXCEEDED",
          `Image assembly logs exceeded ${ASSEMBLY_LOG_LIMIT_BYTES} bytes.`,
        );
      }
    },
  }).finally(() => assemblies.delete(input.tag));
  // A replay callback can fail before its caller starts awaiting this shared promise.
  void finished.catch(() => {});
  return {
    finished,
    listeners,
    get logs() {
      return logs.value;
    },
  };
}

async function imageExists(tag: string): Promise<boolean> {
  const docker = new DockerScope({ timeoutMs: 5_000, containerName: null });
  try {
    await docker.run(["image", "inspect", tag], { outputLimitBytes: 4096 });
    return true;
  } catch (error) {
    if (error instanceof AutomationRuntimeError) throw error;
    return false;
  } finally {
    await docker.close();
  }
}

/**
 * Assembles the run image, and once more when a Docker step failed: this host's containerd has
 * failed layer exports and copies now and then (f-156, f-174), and a second try usually passes.
 * A failed install step is the automation's own: CONTAINER_BUILD_FAILED, which fails the run. A
 * Docker step that fails twice is the platform's: CONTAINER_RUNTIME_UNAVAILABLE, which the run
 * retries within its retry budget, as it does a Docker deadline. A lost containerd lease points
 * to concurrent image pruning; a second loss ends the run with CONTAINER_IMAGE_PRUNE_INTERRUPTED.
 * While another process on the engine assembles the same tag, it waits for that assembly instead.
 */
async function assembleRunImage(input: AssemblyInput): Promise<void> {
  for (let attempt = 1; ; ) {
    try {
      await assembleOnce(input);
      return;
    } catch (error) {
      if (error instanceof AssembledElsewhere) {
        if (await awaitAssemblyElsewhere(input.tag)) return;
        continue;
      }
      if (error instanceof AutomationRuntimeError) throw error;
      if (error instanceof InstallStepFailed) {
        throw new AutomationRuntimeError(
          "CONTAINER_BUILD_FAILED",
          `Container image assembly failed: ${getErrorMessage(error)}`,
          { cause: error },
        );
      }
      const message = getErrorMessage(error);
      const lostLease =
        /lease does not exist/iu.test(message) ||
        /failed to export layer: .*\/io\.containerd\.content\.v1\.content\/ingest\/[0-9a-f]+\/data\b.*no such file or directory/iu.test(
          message,
        );
      if (attempt < ASSEMBLY_ATTEMPTS) {
        input.onLog?.(
          lostLease
            ? "Run image assembly lost its containerd lease, likely to a concurrent docker image prune. Reassembling once.\n"
            : `Run image assembly failed, trying again: ${getErrorMessage(error)}\n`,
        );
        attempt += 1;
        continue;
      }
      if (lostLease) {
        throw new AutomationRuntimeError(
          "CONTAINER_IMAGE_PRUNE_INTERRUPTED",
          `Run image assembly lost its containerd lease again, likely to a concurrent docker image prune. Stop image pruning on this worker host and retry the run. Docker reported: ${getErrorMessage(error)}`,
          { cause: error },
        );
      }
      throw new AutomationRuntimeError(
        "CONTAINER_RUNTIME_UNAVAILABLE",
        `Container image assembly failed: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

interface AssemblyInput {
  readonly automationDirectory: string;
  readonly recipe: RunImageRecipe;
  readonly tag: string;
  readonly onLog?: (chunk: string) => void;
}

class InstallStepFailed extends Error {}

/** Another process on the engine holds the tag's assembly container. */
class AssembledElsewhere extends Error {}

/**
 * The assembly container of a tag. Container names are unique on an engine, so creating it is the
 * lock that lets one process at a time assemble the tag.
 */
function assemblyContainer(tag: string): string {
  return `swizzle-image-${tag.slice(tag.indexOf(":") + 1)}`;
}

/**
 * Waits while another process assembles the tag. Resolves true once the tag exists, and false once
 * that assembly container is gone without it, so the caller assembles. Past that assembly's own
 * deadline its process is gone, and that container, by its id, is removed. A container another
 * process claimed the name with meanwhile gets a deadline of its own.
 */
async function awaitAssemblyElsewhere(tag: string): Promise<boolean> {
  const name = assemblyContainer(tag);
  let holder: string | null = null;
  let deadline = 0;
  for (;;) {
    if (await imageExists(tag)) return true;
    const id = await containerId(name);
    if (id === null) return await imageExists(tag);
    if (id !== holder) {
      holder = id;
      deadline = Date.now() + ASSEMBLY_TIMEOUT_MS + 60_000;
    }
    if (Date.now() >= deadline) break;
    await delay(1_000);
  }
  await new DockerScope({ timeoutMs: 5_000, containerName: holder }).close();
  return false;
}

/** The id of the container with this name, or null when there is none. */
async function containerId(name: string): Promise<string | null> {
  const docker = new DockerScope({ timeoutMs: 5_000, containerName: null });
  try {
    const { stdout } = await docker.run(["container", "inspect", "--format", "{{.Id}}", name], {
      outputLimitBytes: 4096,
    });
    return stdout.trim();
  } catch (error) {
    if (error instanceof AutomationRuntimeError) throw error;
    return null;
  } finally {
    await docker.close();
  }
}

/**
 * Creates a container from the base, copies the source in, runs the install step and commits the
 * result, then tags it. A failure removes the container and any image it committed.
 */
async function assembleOnce(input: AssemblyInput): Promise<void> {
  const { install } = input.recipe;
  const name = assemblyContainer(input.tag);
  const owner = new DockerScope({ timeoutMs: ASSEMBLY_TIMEOUT_MS, containerName: name });
  const docker = (args: readonly string[]) => owner.run(args, { outputLimitBytes: 64 * 1_024 });
  let toolDirectory: string | null = null;
  try {
    if (install !== null) toolDirectory = await mkdtemp(path.join(tmpdir(), "swizzle-tools-"));
    // The stack label carries over to the committed image, so the stack prunes only its own
    // images, and marks the container as the stack's for the Docker broker.
    // The tmpfs keeps install caches in HOME out of the image.
    await claim(owner, [
      "create",
      "--name",
      name,
      "--label",
      stackLabel(),
      "--label",
      workerLabel(),
      "--user",
      SANDBOX_USER,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      ...input.recipe.limits,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
      "--network",
      install === null ? "none" : resolveRunnerNetwork(),
      "--entrypoint",
      "/bin/sh",
      input.recipe.baseImage,
      "-c",
      install === null ? "true" : installScript(install),
    ]);
    // The process that held the name before may have tagged the image; the tag never moves.
    if (await imageExists(input.tag)) {
      await owner.close();
      return;
    }
    // --archive gives every copied file to the container's user, the sandbox user.
    await docker(["cp", "--archive", `${input.automationDirectory}/.`, `${name}:/automation`]);
    if (toolDirectory !== null) {
      await docker(["cp", "--archive", `${toolDirectory}/.`, `${name}:${TOOL_DIRECTORY}`]);
      await runInstallStep(name, input.onLog, owner);
    }
    const committed = await docker([
      "commit",
      ...input.recipe.environment.flatMap((value) => ["--change", `ENV ${value}`]),
      "--change",
      "WORKDIR /automation",
      "--change",
      `ENTRYPOINT ${JSON.stringify(input.recipe.command)}`,
      "--change",
      "CMD []",
      name,
    ]);
    const image = committed.stdout.trim();
    owner.ownImage(image);
    await docker(["tag", image, input.tag]);
    owner.retainImage();
  } catch (error) {
    await owner.close();
    throw error;
  } finally {
    if (toolDirectory !== null) await rm(toolDirectory, { force: true, recursive: true });
  }
  // The tagged image no longer needs the container, so the run does not wait for its removal.
  void owner.close();
}

/** Creates the assembly container, or throws AssembledElsewhere when its name is taken. */
async function claim(owner: DockerScope, create: readonly string[]): Promise<void> {
  try {
    await owner.run(create, { outputLimitBytes: 64 * 1_024 });
  } catch (error) {
    if (
      error instanceof AutomationRuntimeError ||
      !/is already in use/iu.test(getErrorMessage(error))
    )
      throw error;
    owner.releaseContainer();
    throw new AssembledElsewhere();
  }
}

/**
 * Runs the created install container to its end. The step fails when it exits non-zero, or when
 * the container's writable layer grows past the install disk limit, measured every
 * LAYER_CHECK_INTERVAL_MS and once more at the end, so the image the caller commits stays within it.
 * A size that cannot be read fails the step too, so the limit never lapses silently. Every Docker
 * control call has its own deadline within the assembly owner.
 */
async function runInstallStep(
  name: string,
  onLog: ((chunk: string) => void) | undefined,
  owner: DockerScope,
): Promise<void> {
  const limitMb = installDiskLimitMb();
  const limitBytes = limitMb * 1_048_576;
  const finished = new AbortController();
  const guard = guardWritableLayer(
    name,
    limitBytes,
    owner,
    AbortSignal.any([owner.signal, finished.signal]),
  );
  const installation = owner
    .attachInstall(name, {
      ...(onLog !== undefined ? { onStderrChunk: onLog, onStdoutChunk: onLog } : {}),
      outputLimitBytes: 2 * 1_048_576,
    })
    .then(
      () => null,
      (error: unknown) => error,
    )
    .finally(() => finished.abort());
  const [installError, sampledLayerBytes] = await Promise.all([installation, guard]);
  const layerBytes =
    sampledLayerBytes ?? (installError === null ? await writableLayerBytes(name, owner) : null);
  if (layerBytes !== null && layerBytes > limitBytes) {
    throw new InstallStepFailed(
      `The install container's writable layer reached ${Math.round(layerBytes / 1_048_576)} MiB, more than the install disk limit of ${limitMb} MiB set by SWIZZLE_MAX_INSTALL_DISK_MB.`,
    );
  }
  if (installError !== null) {
    // The assembly deadline ends an install that never finishes, the automation's own failure. Any
    // other runtime error, such as a CLI that cannot start, keeps its code. Any other error is the
    // install's only once its container ran and exited non-zero; otherwise Docker failed while
    // running the step.
    const deadline =
      installError instanceof AutomationRuntimeError &&
      installError.code === "DOCKER_CONTROL_TIMEOUT";
    if (!deadline && installError instanceof AutomationRuntimeError) throw installError;
    if (!deadline && !(await exitedNonZero(name, owner))) {
      throw new Error(
        `Docker failed while running the install step: ${getErrorMessage(installError)}`,
        { cause: installError },
      );
    }
    throw new InstallStepFailed(`The install step failed: ${getErrorMessage(installError)}`, {
      cause: installError,
    });
  }
  if (layerBytes === null) {
    throw new InstallStepFailed(
      "Could not read the install container's writable layer size (docker inspect --size), so the install disk limit cannot be checked.",
    );
  }
}

/**
 * Kills the container once its writable layer holds more than `limitBytes`, and resolves with that
 * size; null once `stop` aborts first. Missing sizes are retried, but scoped runtime errors
 * reject the guard so the assembly owner stops the install and cleans up.
 */
async function guardWritableLayer(
  name: string,
  limitBytes: number,
  owner: DockerScope,
  stop: AbortSignal,
): Promise<number | null> {
  for (;;) {
    try {
      await delay(LAYER_CHECK_INTERVAL_MS, undefined, { signal: stop });
    } catch {
      return null;
    }
    const layerBytes = await writableLayerBytes(name, owner);
    if (layerBytes !== null && layerBytes > limitBytes) {
      await owner.run(["kill", name], { outputLimitBytes: 4096 }).catch(() => undefined);
      return layerBytes;
    }
  }
}

/** Whether the container ran and exited with a non-zero code; false when Docker cannot tell. */
async function exitedNonZero(name: string, owner: DockerScope): Promise<boolean> {
  const inspected = await owner
    .run(["container", "inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", name], {
      outputLimitBytes: 4096,
    })
    .catch((error: unknown) => {
      if (error instanceof AutomationRuntimeError) throw error;
      return null;
    });
  const [status, code] = inspected?.stdout.trim().split(" ") ?? [];
  return status === "exited" && code !== "0";
}

/** The container's writable layer size in bytes, or null when Docker cannot report it. */
async function writableLayerBytes(name: string, owner: DockerScope): Promise<number | null> {
  const inspected = await owner
    .run(["container", "inspect", "--size", "--format", "{{.SizeRw}}", name], {
      outputLimitBytes: 4096,
    })
    .catch((error: unknown) => {
      if (error instanceof AutomationRuntimeError) throw error;
      return null;
    });
  const reported = inspected?.stdout.trim() ?? "";
  return /^\d+$/u.test(reported) ? Number(reported) : null;
}

/** The install commands with the egress proxy in their environment only, not in the image. */
function installScript(install: string): string {
  const exports = Object.entries({ ...egressProxyEnvironment(), HOME: "/tmp" })
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `export ${exports} && cd /automation && ${install}`;
}

/**
 * Keeps tags selected from durable ownership and images within the assembly grace period.
 * Removes other stack images by age and disk budget, newest first. Docker refuses removal
 * while a container uses the image, so that image stays until a later pass. Resolves the count
 * removed and the bytes the keep set holds, which no budget bounds.
 */
export async function pruneRunImages(input: {
  readonly keep: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}): Promise<{ readonly removed: number; readonly disk: RunImageDisk }> {
  return await withPassOwner(async (owner) => {
    const docker: DockerCall = (args) => owner.run(args, { outputLimitBytes: 1_048_576 });
    const now = Date.now();
    const budgetBytes = diskBudgetBytes();
    await removeAbandonedContainers();
    const retained = new Map<FootprintGroup, RunImage>();
    const active: RunImage[] = [];
    const fresh: RunImage[] = [];
    const candidates: RunImage[] = [];
    const listed = await listStackRunImages(owner);
    const tagged = await tagUntaggedImages(listed, owner);
    for (const image of await measureImageFootprints(tagged, owner)) {
      if (image.tags.some((tag) => input.keep.has(tag))) active.push(image);
      else if (now - image.createdAt < FRESH_IMAGE_MS) fresh.push(image);
      else candidates.push(image);
    }
    let bytes = 0;
    const retain = async (image: RunImage) => {
      bytes += await additionalImageBytes(image, retained, owner);
      retained.set(image.footprint.group, image);
    };
    for (const image of active) await retain(image);
    const activeBytes = bytes;
    for (const image of fresh) await retain(image);
    const retentionMs =
      positiveInteger("SWIZZLE_RUNNER_IMAGE_RETENTION_HOURS", DEFAULT_IMAGE_RETENTION_HOURS) *
      3_600_000;
    let removed = 0;
    candidates.sort((left, right) => right.createdAt - left.createdAt);
    for (const image of candidates) {
      const { tags } = image;
      const additional = await additionalImageBytes(image, retained, owner);
      if (now - image.createdAt < retentionMs && bytes + additional <= budgetBytes) {
        bytes += additional;
        retained.set(image.footprint.group, image);
        continue;
      }
      // The run tag goes last: an image a container uses keeps it when its removal fails.
      const references = tags.length === 0 ? [image.id] : [...tags].sort(runTagLast);
      try {
        await docker(["image", "rm", ...references]);
        removed += 1;
      } catch (error) {
        if (error instanceof AutomationRuntimeError) throw error;
        bytes += additional;
        retained.set(image.footprint.group, image);
      }
    }
    input.signal?.throwIfAborted();
    return { removed, disk: { activeBytes, budgetBytes } };
  }, input.signal);
}

type DockerCall = (args: readonly string[]) => Promise<{ readonly stdout: string }>;

async function withPassOwner<T>(
  pass: (docker: DockerScope) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const owner = new DockerScope({
    timeoutMs: 60_000,
    containerName: null,
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    return await pass(owner);
  } finally {
    await owner.close();
  }
}

/** This stack's images, as Docker lists and inspects them. */
async function listStackRunImages(owner: DockerScope): Promise<InspectedRunImage[]> {
  const docker: DockerCall = (args) => owner.run(args, { outputLimitBytes: 1_048_576 });
  const listed = await docker([
    "image",
    "ls",
    "--all",
    "--filter",
    `label=${stackLabel()}`,
    "--quiet",
    "--no-trunc",
  ]);
  const ids = [...new Set(listed.stdout.split("\n").map((id) => id.trim()))].filter(Boolean);
  if (ids.length === 0) return [];
  // The CLI inspects its arguments sequentially. Bound parallel batches to fit the pass deadline.
  const batchSize = Math.max(16, Math.ceil(ids.length / 8));
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    batches.push(ids.slice(offset, offset + batchSize));
  }
  const inspected = await Promise.all(
    batches.map((batch) => docker(["image", "inspect", "--format", IMAGE_FORMAT, ...batch])),
  );
  return inspected.flatMap(({ stdout }) => stdout.split("\n").flatMap(parseRunImage));
}

/** Keeps an alias on untagged commits so disk measurements can refer to them until pruning. */
async function tagUntaggedImages(
  images: readonly InspectedRunImage[],
  owner: DockerScope,
): Promise<TaggedRunImage[]> {
  return await Promise.all(
    images.map(async (image): Promise<TaggedRunImage> => {
      let reference = image.tags[0];
      if (reference === undefined) {
        // Removing the only tag can delete the image, so pruning owns this alias's lifetime.
        reference = `swizzle-run:disk-${image.id.replace(/^sha256:/u, "")}`;
        await owner.run(["tag", image.id, reference], { outputLimitBytes: 4096 });
      }
      return { ...image, tags: [reference, ...image.tags.slice(1)] };
    }),
  );
}

async function measureImageFootprints(
  images: readonly TaggedRunImage[],
  owner: DockerScope,
): Promise<RunImage[]> {
  if (images.length === 0) return [];
  const usage = parseImageUsage(await owner.imageUsage(null));
  const layerUses = new Map<string, number>();
  const bases = new Map<string, InspectedRunImage[]>();
  for (const image of images) {
    for (const layer of image.layers) layerUses.set(layer, (layerUses.get(layer) ?? 0) + 1);
    const base = image.layers.slice(0, -1).join("/");
    const group = bases.get(base) ?? [];
    group.push(image);
    bases.set(base, group);
  }
  // A private final layer cannot share bytes with another image. With two such images,
  // Docker's shared size is the entire common base, so later images add only private bytes.
  const sharedBases = new Map<string, FootprintGroup>();
  for (const [base, group] of bases) {
    const first = group[0];
    if (first === undefined || group.length < 2) continue;
    const baseBytes = usage.get(first.id)?.sharedBytes;
    if (
      group.every((image) => {
        const source = image.layers.at(-1);
        return (
          source !== undefined &&
          layerUses.get(source) === 1 &&
          usage.get(image.id)?.sharedBytes === baseBytes
        );
      })
    )
      sharedBases.set(base, { kind: "base", layers: first.layers.slice(0, -1) });
  }
  return images.map((image) => {
    const measured = usage.get(image.id);
    if (measured === undefined) throw new Error(`Cannot read disk use of run image ${image.id}.`);
    const reference = image.tags[0];
    const base = image.layers.slice(0, -1).join("/");
    return {
      ...image,
      bytes: measured.bytes,
      footprint: {
        reference,
        group: sharedBases.get(base) ?? { kind: "image", id: image.id },
        sharedBytes: measured.sharedBytes,
      },
    };
  });
}

type FootprintGroup =
  | { readonly kind: "base"; readonly layers: readonly string[] }
  | { readonly kind: "image"; readonly id: string };

interface RunImage {
  readonly id: string;
  readonly createdAt: number;
  readonly bytes: number;
  readonly layers: readonly string[];
  readonly footprint: {
    readonly group: FootprintGroup;
    readonly sharedBytes: number;
    readonly reference: string;
  };
  readonly tags: readonly string[];
}

type InspectedRunImage = Omit<RunImage, "footprint">;
type TaggedRunImage = Omit<InspectedRunImage, "tags"> & {
  readonly tags: readonly [string, ...string[]];
};

/** One line of IMAGE_FORMAT output; none when the line is not one. */
function parseRunImage(line: string): InspectedRunImage[] {
  if (line.trim() === "") return [];
  const parsed: unknown = JSON.parse(line);
  if (!Array.isArray(parsed)) return [];
  const [id, created, bytes, tags, layers] = parsed as unknown[];
  if (typeof id !== "string" || typeof created !== "string" || typeof bytes !== "number") return [];
  return [
    {
      bytes,
      layers: Array.isArray(layers) ? layers.filter((layer) => typeof layer === "string") : [],
      createdAt: Date.parse(created),
      id,
      tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string") : [],
    },
  ];
}

/** Private commit layers are additive after one image from their base group is retained. */
async function additionalImageBytes(
  image: RunImage,
  retained: ReadonlyMap<FootprintGroup, RunImage>,
  docker: DockerScope,
): Promise<number> {
  if (retained.has(image.footprint.group)) return image.bytes - image.footprint.sharedBytes;
  if (retained.size === 0) return image.bytes;
  const references = [...retained.values()].map((entry) => entry.footprint.reference);
  const usage = parseImageUsage(
    await docker.imageUsage([...references, image.footprint.reference]),
  );
  const measured = usage.get(image.id);
  if (measured === undefined)
    throw new Error(`Cannot read shared disk use of run image ${image.id}.`);
  return measured.bytes - measured.sharedBytes;
}

function parseImageUsage(value: unknown): Map<string, { bytes: number; sharedBytes: number }> {
  if (!Array.isArray(value)) throw new Error("Cannot read Docker image disk use.");
  const usage = new Map<string, { bytes: number; sharedBytes: number }>();
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("Id" in entry) ||
      typeof entry.Id !== "string" ||
      !("Size" in entry) ||
      typeof entry.Size !== "number" ||
      !Number.isSafeInteger(entry.Size) ||
      !("SharedSize" in entry) ||
      typeof entry.SharedSize !== "number" ||
      !Number.isSafeInteger(entry.SharedSize) ||
      entry.SharedSize < 0 ||
      entry.SharedSize > entry.Size
    )
      throw new Error("Cannot read Docker image disk use.");
    usage.set(entry.Id, { bytes: entry.Size, sharedBytes: entry.SharedSize });
  }
  return usage;
}

function diskBudgetBytes(): number {
  return positiveInteger("SWIZZLE_RUNNER_IMAGE_DISK_MB", DEFAULT_IMAGE_DISK_MB) * 1_048_576;
}

function runTagLast(left: string, right: string): number {
  return Number(RUN_TAG.test(left)) - Number(RUN_TAG.test(right));
}

function positiveInteger(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isSafeInteger(configured) && configured >= 1 ? configured : fallback;
}

function nodeInstallCommand(lockfile: string | undefined): string {
  if (lockfile?.endsWith("pnpm-lock.yaml")) {
    return "corepack pnpm install --prod --frozen-lockfile --ignore-scripts";
  }
  if (lockfile?.endsWith("yarn.lock")) {
    return "corepack yarn install --immutable --mode=skip-builds";
  }
  if (lockfile !== undefined) return "npm ci --omit=dev --ignore-scripts --no-audit --no-fund";
  return "npm install --omit=dev --ignore-scripts --no-audit --no-fund";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isSafeImageReference(value: string): boolean {
  return (
    value.length <= 255 &&
    !/[\s'"\\]/u.test(value) &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/u.test(value)
  );
}

async function hashAutomationDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (current: string, relative: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".swizzle")
        continue;
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) {
        const metadata = await stat(absolutePath);
        hash.update(relativePath);
        hash.update(String(metadata.size));
        hash.update(await readFile(absolutePath));
      }
    }
  };
  await visit(directory, "");
  return hash.digest("hex");
}
