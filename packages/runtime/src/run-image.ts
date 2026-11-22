import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AutomationRuntimeConfig } from "@swizzle/config";
import { BoundedOutput } from "./bounded-output.js";

import { containerLimitArguments, installDiskLimitMb } from "./container-limits.js";
import { DockerScope, stackLabel, workerLabel } from "./docker-cli.js";
import { AutomationRuntimeError, getErrorMessage } from "./errors.js";
import {
  egressProxyEnvironment,
  resolveRunnerNetwork,
  SANDBOX_USER,
  usesManagedRunner,
} from "./sandbox.js";
import type { AutomationDefinition } from "./validation.js";

const ASSEMBLY_ATTEMPTS = 2;
const ASSEMBLY_TIMEOUT_MS = 10 * 60 * 1_000;
const LAYER_CHECK_INTERVAL_MS = 1_000;
const TOOL_DIRECTORY = "/opt/swizzle";
const NODE_BASE_IMAGE = "node:26.12.1-trixie-slim";
export const FALLBACK_BASE_IMAGES: Record<AutomationRuntimeConfig["language"], string> = {
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

export interface RunImageRecipe {
  readonly baseImage: string;
  readonly install: string | null;
  readonly environment: readonly string[];
  readonly command: readonly string[];
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
  void finished.catch(() => undefined);
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

class AssembledElsewhere extends Error {}

function assemblyContainer(tag: string): string {
  return `swizzle-image-${tag.slice(tag.indexOf(":") + 1)}`;
}

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

async function assembleOnce(input: AssemblyInput): Promise<void> {
  const { install } = input.recipe;
  const name = assemblyContainer(input.tag);
  const owner = new DockerScope({ timeoutMs: ASSEMBLY_TIMEOUT_MS, containerName: name });
  const docker = (args: readonly string[], deadline: "control" | "transfer" = "control") =>
    owner.run(args, { outputLimitBytes: 64 * 1_024, deadline });
  let toolDirectory: string | null = null;
  try {
    if (install !== null) toolDirectory = await mkdtemp(path.join(tmpdir(), "swizzle-tools-"));
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
    if (await imageExists(input.tag)) {
      await owner.close();
      return;
    }
    await docker(
      ["cp", "--archive", `${input.automationDirectory}/.`, `${name}:/automation`],
      "transfer",
    );
    if (toolDirectory !== null) {
      await docker(
        ["cp", "--archive", `${toolDirectory}/.`, `${name}:${TOOL_DIRECTORY}`],
        "transfer",
      );
      await runInstallStep(name, input.onLog, owner);
    }
    const committed = await docker(
      [
        "commit",
        ...input.recipe.environment.flatMap((value) => ["--change", `ENV ${value}`]),
        "--change",
        "WORKDIR /automation",
        "--change",
        `ENTRYPOINT ${JSON.stringify(input.recipe.command)}`,
        "--change",
        "CMD []",
        name,
      ],
      "transfer",
    );
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
  void owner.close();
}

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
      ...(onLog !== undefined
        ? { onStderrChunk: onLog, stdout: { kind: "text", onChunk: onLog } }
        : {}),
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

function installScript(install: string): string {
  const exports = Object.entries({ ...egressProxyEnvironment(), HOME: "/tmp" })
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `export ${exports} && cd /automation && ${install}`;
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

export function isSafeImageReference(value: string): boolean {
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
