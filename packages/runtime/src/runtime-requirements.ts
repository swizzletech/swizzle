import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { StepSite } from "@swizzle/config";
import {
  AUTOMATION_RUNTIME_PROFILE_DEFAULT,
  type AutomationConfig,
  type AutomationRuntimeConfig,
  WORKER_SERVICES,
  type WorkerService,
} from "@swizzle/config";
import { createDisplayName } from "@swizzle/core";
import type {
  CredentialState,
  DeclaredConnectionStatus,
  StoredBuildSnapshot,
  WorkerCapabilities,
} from "@swizzle/db";
import { z } from "zod";

import { containerLimitIssues } from "./container-limits.js";
import { AutomationRuntimeError } from "./errors.js";
import type {
  ReadinessWorker,
  RuntimeReadinessReport,
  RuntimeRequirementIssue,
} from "./platform-records.js";
import { assertRuntimeTimeoutWithinPlatformCeiling } from "./timeout-policy.js";

const require = createRequire(import.meta.url);
const commandVersionCache = new Map<string, Promise<string | null>>();
const DEFAULT_QUEUE_PREFIX = "platform-runs";
export type RuntimeSnapshot = AutomationRuntimeConfig;

export type BuildSnapshot = StoredBuildSnapshot;
type Binaries = WorkerCapabilities["binaries"];

/** What readiness reads of an automation: its runtime block and the folder its files are in. */
export interface RuntimeDefinitionLike {
  readonly config: Pick<AutomationConfig, "runtime">;
  readonly directory: string;
}

export interface RuntimeReadinessOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Per-automation timeout grant (ms) for this automation + environment, if any.
   * Raises the effective `runtime.timeout` ceiling above the global platform ceiling.
   */
  readonly grantMaxTimeoutMs?: number | null;
}

function createQueueProfileSegment(profile: string): string {
  const normalized = createDisplayName(profile || AUTOMATION_RUNTIME_PROFILE_DEFAULT)
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^[-_]+|[-_]+$/g, "");

  return normalized.length > 0 ? normalized : AUTOMATION_RUNTIME_PROFILE_DEFAULT;
}

/** Whether a readiness worker serves a project; the stack's local worker serves every one. */
export function servesProject(
  worker: { readonly projectIds: readonly string[] | "all" },
  projectId: string,
): boolean {
  return worker.projectIds === "all" || worker.projectIds.includes(projectId);
}

export function createQueueNameForProfile(profile: string): string {
  return `${DEFAULT_QUEUE_PREFIX}--${createQueueProfileSegment(profile)}`;
}

export function createRuntimeSnapshot(config: AutomationConfig): RuntimeSnapshot {
  return {
    ...(config.runtime.container !== undefined
      ? { container: { ...config.runtime.container } }
      : {}),
    execution_mode: config.runtime.execution_mode,
    language: config.runtime.language,
    on_overlap: config.runtime.on_overlap,
    permissions: {
      services: [...config.runtime.permissions.services],
      network: config.runtime.permissions.network,
      writable_dirs: [...config.runtime.permissions.writable_dirs],
    },
    profile: config.runtime.profile,
    queue_timeout: config.runtime.queue_timeout,
    rate_limits: { ...config.runtime.rate_limits },
    requirements: {
      binaries: config.runtime.requirements.binaries.map((binary) => ({ ...binary })),
      ...(config.runtime.requirements.node !== undefined
        ? { node: { ...config.runtime.requirements.node } }
        : {}),
      ...(config.runtime.requirements.python !== undefined
        ? { python: { ...config.runtime.requirements.python } }
        : {}),
    },
    retry: { ...config.runtime.retry },
    timeout: config.runtime.timeout,
  };
}

export function getDeclaredDependencyManifestPaths(
  definition: RuntimeDefinitionLike,
): readonly string[] {
  return [
    ...(definition.config.runtime.requirements.python
      ? [definition.config.runtime.requirements.python.requirements_file]
      : []),
    ...(definition.config.runtime.requirements.node
      ? [
          definition.config.runtime.requirements.node.package_json,
          ...(definition.config.runtime.requirements.node.lockfile
            ? [definition.config.runtime.requirements.node.lockfile]
            : []),
        ]
      : []),
  ];
}

export async function evaluateLocalAutomationReadiness(
  definition: RuntimeDefinitionLike,
  options: RuntimeReadinessOptions = {},
): Promise<RuntimeReadinessReport> {
  return evaluateAutomationReadiness(
    definition,
    [await thisMachine(definition.config.runtime, "this-machine")],
    options,
  );
}

/**
 * This machine as the one worker of a local check or a test platform: in the automation's
 * group, granted every service, with the capabilities it measures now.
 */
export async function thisMachine(
  runtime: Pick<AutomationRuntimeConfig, "profile" | "requirements">,
  instanceId: string,
): Promise<ReadinessWorker> {
  return {
    availability: "online",
    capabilities: await collectWorkerCapabilities(
      await findBinaries(runtime.requirements.binaries),
    ),
    concurrency: 1,
    instanceId,
    name: "This machine",
    profiles: [{ name: runtime.profile, queueName: createQueueNameForProfile(runtime.profile) }],
    services: WORKER_SERVICES,
  };
}

export function createRawSourceBuildSnapshot(
  config: AutomationConfig,
  stepSites: readonly StepSite[],
): BuildSnapshot {
  const steps: BuildSnapshot["steps"] = [
    {
      kind: "python-requirements",
      lockfilePath: null,
      logPath: null,
      manifestPath: config.runtime.requirements.python?.requirements_file ?? "requirements.txt",
      outputPath: null,
      packageManager: "pip",
      status: "not-required",
    },
    {
      kind: "node-dependencies",
      lockfilePath: config.runtime.requirements.node?.lockfile ?? null,
      logPath: null,
      manifestPath: config.runtime.requirements.node?.package_json ?? "package.json",
      outputPath: null,
      packageManager: "npm",
      status: "not-required",
    },
  ];

  return {
    format: "raw-source-v1",
    stepSites,
    packagedAt: new Date().toISOString(),
    status: "not-required",
    steps,
  };
}

export function evaluateAutomationReadiness(
  definition: RuntimeDefinitionLike,
  workers: readonly ReadinessWorker[],
  options: RuntimeReadinessOptions = {},
): RuntimeReadinessReport {
  const checkedAt = new Date().toISOString();
  const errors: RuntimeRequirementIssue[] = [];
  const warnings: RuntimeRequirementIssue[] = [];
  const queueName = createQueueNameForProfile(definition.config.runtime.profile);

  try {
    assertRuntimeTimeoutWithinPlatformCeiling(definition.config.runtime.timeout, {
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      ...(options.grantMaxTimeoutMs !== undefined
        ? { grantMaxTimeoutMs: options.grantMaxTimeoutMs }
        : {}),
    });
  } catch (error) {
    if (error instanceof AutomationRuntimeError) {
      errors.push({
        code:
          error.code === "TIMEOUT_FORMAT_INVALID"
            ? "TIMEOUT_FORMAT_INVALID"
            : "RUNTIME_TIMEOUT_EXCEEDS_MAX",
        message: error.message,
        subject: "runtime.timeout",
      });
    } else {
      throw error;
    }
  }

  for (const issue of containerLimitIssues(definition.config.runtime, options.environment)) {
    errors.push({ code: "RUNTIME_CONTAINER_LIMIT_EXCEEDS_MAX", ...issue });
  }

  for (const relativePath of getDeclaredDependencyManifestPaths(definition)) {
    const absolutePath = path.join(definition.directory, relativePath);
    try {
      const fileStats = statSyncLike(absolutePath);
      if (!fileStats.isFile) {
        throw new Error("not-file");
      }
    } catch {
      errors.push({
        code: "DEPENDENCY_MANIFEST_MISSING",
        message: `Declared dependency manifest was not found: ${relativePath}`,
        subject: relativePath,
      });
    }
  }

  if (
    definition.config.runtime.requirements.node !== undefined &&
    definition.config.runtime.requirements.node.lockfile === undefined
  ) {
    warnings.push({
      code: "NODE_LOCKFILE_MISSING",
      message:
        "Node dependency packaging is declared without a lockfile. Swizzle can still package it, but it is less reproducible.",
      subject: definition.config.runtime.requirements.node.package_json,
    });
  }

  const availableProfiles = Array.from(
    new Set(workers.flatMap((worker) => worker.profiles.map((profile) => profile.name))),
  ).sort();
  const { runtime } = definition.config;
  const assessed = workers.map((worker) => ({ worker, gaps: workerGaps(runtime, worker) }));
  const without = (kind: WorkerGap["kind"]) => (worker: (typeof assessed)[number]) =>
    !worker.gaps.some((gap) => gap.kind === kind);
  const inGroup = assessed.filter(without("group"));
  const granted = inGroup.filter(without("service"));
  const matching = granted.filter(without("offline"));
  const compatibleWorkers = matching.flatMap(({ worker, gaps }) =>
    gaps.length === 0 ? [worker] : [],
  );

  if (granted.length > 0 && matching.length === 0) {
    warnings.push({
      code: "RUNTIME_PROFILE_UNAVAILABLE",
      message: `Every worker in group "${runtime.profile}" is offline. Deploy proceeds; a run waits up to runtime.queue_timeout for one to come online and never runs in another group.`,
      subject: runtime.profile,
    });
    return {
      availableProfiles,
      checkedAt,
      compatibleWorkerInstanceIds: [],
      errors,
      executionMode: runtime.execution_mode,
      language: runtime.language,
      matchingWorkerCount: 0,
      profile: runtime.profile,
      queueName,
      status: errors.length > 0 ? "not-ready" : "ready",
      warnings,
    };
  }

  if (inGroup.length === 0) {
    errors.push({
      code: "RUNTIME_PROFILE_UNAVAILABLE",
      message: `No worker serves group "${runtime.profile}" here. \`swizzle worker groups\` lists the groups that do; an owner or admin grants a worker a group.`,
      subject: runtime.profile,
    });
  } else if (compatibleWorkers.length === 0) {
    // No worker of the group can run it alone; each one's gaps say why. Grants come first: a
    // worker missing a service never takes the run, whatever it reports.
    for (const { worker, gaps } of granted.length === 0 ? inGroup : matching) {
      for (const gap of gaps) errors.push(gapIssue(worker, gap));
    }
  }

  return {
    availableProfiles,
    checkedAt,
    compatibleWorkerInstanceIds: compatibleWorkers.map((worker) => worker.instanceId),
    errors,
    executionMode: runtime.execution_mode,
    language: runtime.language,
    matchingWorkerCount: matching.length,
    profile: runtime.profile,
    queueName,
    status: errors.length > 0 ? "not-ready" : "ready",
    warnings,
  };
}

/** One thing that keeps a worker from running an automation; see `workerGaps`. */
export type WorkerGap =
  | { readonly kind: "group"; readonly profile: string }
  | { readonly kind: "service"; readonly service: WorkerService }
  | { readonly kind: "offline" }
  | { readonly kind: "execution-mode"; readonly mode: AutomationRuntimeConfig["execution_mode"] }
  | { readonly kind: "language"; readonly language: AutomationRuntimeConfig["language"] }
  | { readonly kind: "binary-missing"; readonly name: string }
  | {
      readonly kind: "binary-version";
      readonly name: string;
      /** Null when the worker could not tell the version, which no rule accepts. */
      readonly version: string | null;
      readonly required: string;
    };

/**
 * What keeps one worker from running an automation with this runtime; none when it can. A
 * deployment is ready when one worker has no gap, whatever the order of the workers, and the
 * readiness errors and the deploy gate's words both come from these gaps. Groups and services
 * are grants, as placement reads them (`workerFit`); an offline worker reports no capabilities,
 * so only its grants count.
 */
export function workerGaps(
  runtime: AutomationRuntimeConfig,
  worker: ReadinessWorker,
): readonly WorkerGap[] {
  const gaps: WorkerGap[] = [];
  if (!worker.profiles.some((profile) => profile.name === runtime.profile)) {
    gaps.push({ kind: "group", profile: runtime.profile });
  }
  for (const service of runtime.permissions.services) {
    if (!worker.services.includes(service)) gaps.push({ kind: "service", service });
  }
  if (worker.availability === "offline") return [...gaps, { kind: "offline" }];
  const { capabilities } = worker;
  if (!capabilities.executionModes.includes(runtime.execution_mode)) {
    gaps.push({ kind: "execution-mode", mode: runtime.execution_mode });
  }
  if (!capabilities.languages.some((language) => language.name === runtime.language)) {
    gaps.push({ kind: "language", language: runtime.language });
  }
  for (const required of runtime.requirements.binaries) {
    const found = capabilities.binaries.find((binary) => binary.name === required.name);
    if (found === undefined) gaps.push({ kind: "binary-missing", name: required.name });
    else if (
      required.version !== undefined &&
      (found.version === null || !matchesVersionRequirement(found.version, required.version))
    ) {
      gaps.push({
        kind: "binary-version",
        name: found.name,
        version: found.version,
        required: required.version,
      });
    }
  }
  return gaps;
}

/** "is not in group "gpu", does not run python and lacks the binary ffmpeg". */
export function gapsInWords(gaps: readonly WorkerGap[]): string {
  if (gaps.length === 0) return "meets the group, services, language and binaries";
  const phrases: string[] = [];
  const missing: string[] = [];
  for (const gap of gaps) {
    switch (gap.kind) {
      case "group":
        phrases.push(`is not in group "${gap.profile}"`);
        break;
      case "service":
        phrases.push(`is not granted the service ${gap.service}`);
        break;
      case "offline":
        phrases.push("is offline, so it reports no languages or binaries");
        break;
      case "execution-mode":
        phrases.push(`does not offer ${gap.mode} execution`);
        break;
      case "language":
        phrases.push(`does not run ${gap.language}`);
        break;
      case "binary-missing":
        missing.push(gap.name);
        break;
      case "binary-version":
        phrases.push(
          `has ${gap.name} ${gap.version ?? "in a version it cannot tell"} where ${gap.required} is required`,
        );
        break;
    }
  }
  if (missing.length > 0) {
    phrases.push(
      `lacks ${missing.length === 1 ? "the binary" : "the binaries"} ${missing.join(", ")}`,
    );
  }
  return phrases.length < 2
    ? phrases.join("")
    : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

function gapIssue(worker: ReadinessWorker, gap: WorkerGap): RuntimeRequirementIssue {
  const message = `${worker.name} ${gapsInWords([gap])}.`;
  const issue = { message, worker: worker.name };
  switch (gap.kind) {
    case "group":
    case "offline":
      return { ...issue, code: "RUNTIME_PROFILE_UNAVAILABLE", subject: "runtime.profile" };
    case "service":
      return { ...issue, code: "RUNTIME_SERVICE_NOT_GRANTED", subject: gap.service };
    case "execution-mode":
      return {
        ...issue,
        code:
          gap.mode === "container" ? "CONTAINER_DOCKER_UNAVAILABLE" : "RUNTIME_PROFILE_UNAVAILABLE",
        subject: "runtime.execution_mode",
      };
    case "language":
      return { ...issue, code: "LANGUAGE_RUNTIME_UNAVAILABLE", subject: gap.language };
    case "binary-missing":
      return { ...issue, code: "BINARY_REQUIREMENT_MISSING", subject: gap.name };
    case "binary-version":
      return { ...issue, code: "BINARY_VERSION_UNSUPPORTED", subject: gap.name };
  }
}

/**
 * A deployed automation's readiness: its runtime readiness, not ready while a declared secret is
 * unset or a declared connection is not active in its environment, because then no run starts.
 * The deploy gate judges the runtime alone, so a deployment can go out before its credentials.
 */
export function addCredentialIssues(
  readiness: RuntimeReadinessReport,
  credentials: {
    readonly environment: string;
    readonly connections: readonly {
      readonly name: string;
      readonly status: DeclaredConnectionStatus;
    }[];
    readonly secrets: readonly { readonly name: string; readonly state: CredentialState }[];
  },
): RuntimeReadinessReport {
  const issues: RuntimeRequirementIssue[] = [
    ...credentials.secrets
      .filter((secret) => secret.state !== "bound")
      .map((secret) => ({
        code: "SECRET_MISSING" as const,
        message:
          secret.state === "missing"
            ? `Secret ${secret.name} is not set in ${credentials.environment}. Set it and deploy again.`
            : `Secret ${secret.name} was set again in ${credentials.environment} after this deploy. Deploy again to use it.`,
        subject: secret.name,
      })),
    ...credentials.connections
      .filter((connection) => connection.status !== "active")
      .map((connection) => ({
        code: "CONNECTION_NOT_ACTIVE" as const,
        message: connectionIssue(connection.name, connection.status, credentials.environment),
        subject: connection.name,
      })),
  ];
  if (issues.length === 0) return readiness;
  return { ...readiness, errors: [...readiness.errors, ...issues], status: "not-ready" };
}

function connectionIssue(
  name: string,
  status: DeclaredConnectionStatus,
  environment: string,
): string {
  switch (status) {
    case "missing":
      return `Connection ${name} is not connected in ${environment}. Connect it and deploy again.`;
    case "unbound":
      return `Connection ${name} was connected again in ${environment} after this deploy. Deploy again to use it.`;
    default:
      return `Connection ${name} is ${status} in ${environment}.`;
  }
}

export function buildRuntimeEnvironmentAdditions(input: {
  readonly automationDirectory: string;
  readonly runtime: AutomationRuntimeConfig;
  readonly dependencyEnvironment?: NodeJS.ProcessEnv | undefined;
}): NodeJS.ProcessEnv {
  const additions: NodeJS.ProcessEnv = {
    ...(input.dependencyEnvironment ?? {}),
  };

  if (input.runtime.requirements.python) {
    const packagedPythonPath = path.join(
      input.automationDirectory,
      ".swizzle",
      "python",
      "site-packages",
    );
    additions.PYTHONPATH = appendPathEntry(
      additions.PYTHONPATH ?? process.env.PYTHONPATH,
      packagedPythonPath,
    );
  }

  return additions;
}

/** Where the runner-base build records the binaries a deployed run can call (infra/docker/runner-tools.mjs). */
const RUNNER_TOOLS_FILE = "/etc/swizzle/runner-tools.json";

const runnerTools = z.object({
  binaries: z.array(z.object({ name: z.string().min(1), version: z.string().nullable() })),
});

/**
 * The binaries a deployed run finds in the runner image, as the image's build recorded them. A
 * worker that requires the sandbox reports these, since its runs never see its own PATH.
 */
export async function readRunnerTools(file = RUNNER_TOOLS_FILE): Promise<Binaries> {
  return runnerTools.parse(JSON.parse(await readFile(file, "utf8"))).binaries;
}

/**
 * What a worker can run: languages, execution modes and dependency packaging measured on this
 * host, and `binaries`, the executables its runs call, such as the runner image's. Node, npm,
 * python3 and pip measured here stand in for any of them `binaries` does not name.
 */
export async function collectWorkerCapabilities(binaries: Binaries): Promise<WorkerCapabilities> {
  const pythonVersion = await detectCommandVersion("python3", ["--version"]);
  const nodeVersion = process.version.replace(/^v/, "");
  const pipVersion = await detectPythonPipAvailability();
  const npmVersion = await detectCommandVersion("npm", ["--version"]);
  const dockerVersion = await detectCommandVersion("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const named = new Set(binaries.map((binary) => binary.name));
  const measured = Object.entries({
    node: nodeVersion,
    npm: npmVersion,
    python3: pythonVersion,
    pip: pipVersion,
  }).flatMap(([name, version]) =>
    version !== null && !named.has(name) ? [{ name, version }] : [],
  );

  return {
    binaries: [...binaries, ...measured],
    dependencyPackaging: {
      node: npmVersion !== null,
      python: pipVersion !== null,
    },
    executionModes: [
      "host",
      "profile",
      ...(dockerVersion !== null ? (["container"] as const) : []),
    ],
    languages: [
      ...(pythonVersion ? [{ name: "python", version: pythonVersion } as const] : []),
      { name: "node", version: nodeVersion } as const,
      // Node runs TypeScript itself once it can strip types.
      ...(process.features.typescript
        ? [{ name: "typescript", version: nodeVersion } as const]
        : []),
    ],
  };
}

/**
 * The declared binaries on this machine's PATH. A version is read only for a declaration with a
 * version rule, from the first of `--version`, `-v` and `-V` that prints one: pdftoppm, for one,
 * knows only `-v`.
 */
async function findBinaries(
  declared: AutomationRuntimeConfig["requirements"]["binaries"],
): Promise<Binaries> {
  const found: Binaries[number][] = [];
  for (const binary of declared) {
    const file = await findOnPath(binary.name);
    if (file === null) continue;
    let version: string | null = null;
    for (const flag of binary.version === undefined ? [] : ["--version", "-v", "-V"]) {
      version = await detectCommandVersion(file, [flag]);
      if (version !== null) break;
    }
    found.push({ name: binary.name, version });
  }
  return found;
}

async function findOnPath(name: string): Promise<string | null> {
  const extensions =
    process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE").split(";")] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const file = path.join(directory, `${name}${extension}`);
      try {
        await access(file, constants.X_OK);
        if ((await stat(file)).isFile()) return file;
      } catch {}
    }
  }
  return null;
}

async function detectCommandVersion(
  command: string,
  args: readonly string[],
): Promise<string | null> {
  const cacheKey = `${command} ${args.join(" ")}`;
  const cached = commandVersionCache.get(cacheKey);
  if (cached) {
    return await cached;
  }

  const pending = new Promise<string | null>((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => resolve(null));
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        resolve(null);
        return;
      }

      resolve(extractVersionFromOutput(output));
    });
  });
  commandVersionCache.set(cacheKey, pending);
  return await pending;
}

async function detectPythonPipAvailability(): Promise<string | null> {
  return await detectCommandVersion("python3", ["-m", "pip", "--version"]);
}

function extractVersionFromOutput(output: string): string | null {
  const match = output.match(/\bv?(\d+(?:\.\d+){0,3})\b/);
  return match?.[1] ?? null;
}

function matchesVersionRequirement(actualVersion: string, requirement: string): boolean {
  const trimmedRequirement = requirement.trim();
  const actualParts = parseVersion(actualVersion);
  const requiredParts = parseVersion(trimmedRequirement.replace(/^[^\d]*/, ""));
  if (requiredParts.length === 0 || actualParts.length === 0) {
    return true;
  }

  if (trimmedRequirement.startsWith(">=")) {
    return compareVersions(actualParts, requiredParts) >= 0;
  }

  if (trimmedRequirement.startsWith(">")) {
    return compareVersions(actualParts, requiredParts) > 0;
  }

  if (trimmedRequirement.startsWith("<=")) {
    return compareVersions(actualParts, requiredParts) <= 0;
  }

  if (trimmedRequirement.startsWith("<")) {
    return compareVersions(actualParts, requiredParts) < 0;
  }

  if (trimmedRequirement.startsWith("=")) {
    return compareVersions(actualParts, requiredParts) === 0;
  }

  return compareVersions(actualParts, requiredParts) === 0;
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

function parseVersion(value: string): number[] {
  return value
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function appendPathEntry(existing: string | undefined, entry: string): string {
  return existing && existing.length > 0 ? `${entry}${path.delimiter}${existing}` : entry;
}

function statSyncLike(filePath: string): { readonly isFile: boolean } {
  const stats = require("node:fs").statSync(filePath);
  return {
    isFile: stats.isFile(),
  };
}
