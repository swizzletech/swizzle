import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AutomationConfig } from "@swizzle/config";

import { AutomationRuntimeError, getErrorMessage } from "./errors.js";

const DEFAULT_CACHE_ENTRIES_PER_LANGUAGE = 10;
const LOCK_POLL_MS = 250;
const LOCK_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_BYTES = 8_192;
const DEPENDENCY_ENV_ALLOWLIST = new Set([
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
]);

export interface DependencyPreparationResult {
  readonly environment: NodeJS.ProcessEnv;
}

export async function prepareAutomationDependencies(input: {
  readonly automationDirectory: string;
  readonly cacheMode: "local" | "worker";
  readonly config: AutomationConfig;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onLog?: (chunk: string) => void;
}): Promise<DependencyPreparationResult> {
  if (await hasDeployTimePackagedDependencies(input.automationDirectory)) {
    return { environment: {} };
  }

  const sourceEnvironment = input.environment ?? process.env;
  const cacheRoot = resolveDependencyCacheRoot(input.cacheMode, sourceEnvironment);
  const environment = buildDependencyInstallEnvironment(sourceEnvironment, cacheRoot);
  await mkdir(environment.HOME as string, { recursive: true, mode: 0o700 });
  const additions: NodeJS.ProcessEnv = {};

  if (input.config.runtime.requirements.python !== undefined) {
    Object.assign(
      additions,
      await preparePythonDependencies({
        automationDirectory: input.automationDirectory,
        cacheMode: input.cacheMode,
        cacheRoot,
        environment,
        ...(input.onLog !== undefined ? { onLog: input.onLog } : {}),
        requirementsFile: input.config.runtime.requirements.python.requirements_file,
      }),
    );
    await pruneLanguageCache(path.join(cacheRoot, "python"));
  }

  if (input.config.runtime.requirements.node !== undefined) {
    await prepareNodeDependencies({
      automationDirectory: input.automationDirectory,
      cacheMode: input.cacheMode,
      cacheRoot,
      environment,
      lockfile: input.config.runtime.requirements.node.lockfile ?? null,
      ...(input.onLog !== undefined ? { onLog: input.onLog } : {}),
      packageJson: input.config.runtime.requirements.node.package_json,
    });
    await pruneLanguageCache(path.join(cacheRoot, "node"));
  }

  return { environment: additions };
}

export function buildDependencyInstallEnvironment(
  source: NodeJS.ProcessEnv,
  cacheRoot: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && DEPENDENCY_ENV_ALLOWLIST.has(key)) environment[key] = value;
  }
  const home = path.join(cacheRoot, "installer-home");
  return {
    ...environment,
    CI: "true",
    HOME: home,
    npm_config_audit: "false",
    npm_config_cache: path.join(cacheRoot, "npm-cache"),
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    PIP_CACHE_DIR: path.join(cacheRoot, "pip-cache"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
  };
}

function resolveDependencyCacheRoot(
  cacheMode: "local" | "worker",
  environment: NodeJS.ProcessEnv,
): string {
  if (environment.SWIZZLE_DEP_CACHE_DIR && environment.SWIZZLE_DEP_CACHE_DIR.length > 0) {
    return path.resolve(environment.SWIZZLE_DEP_CACHE_DIR);
  }

  if (cacheMode === "local") {
    return path.join(os.homedir(), ".swizzle", "dep-cache");
  }

  if (environment.SWIZZLE_ARTIFACTS_DIR && environment.SWIZZLE_ARTIFACTS_DIR.length > 0) {
    return path.join(path.dirname(path.resolve(environment.SWIZZLE_ARTIFACTS_DIR)), "dep-cache");
  }

  throw new AutomationRuntimeError(
    "DEPENDENCY_CACHE_DIR_MISSING",
    "A worker needs SWIZZLE_DEP_CACHE_DIR (or SWIZZLE_ARTIFACTS_DIR, which places the cache beside it) to prepare automation dependencies.",
  );
}

async function preparePythonDependencies(input: {
  readonly automationDirectory: string;
  readonly cacheMode: "local" | "worker";
  readonly cacheRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onLog?: (chunk: string) => void;
  readonly requirementsFile: string;
}): Promise<NodeJS.ProcessEnv> {
  const manifestPath = path.join(input.automationDirectory, input.requirementsFile);
  const requirements = await readRequiredFile(manifestPath, input.requirementsFile);
  const pythonVersion = await detectCommandVersion("python3", ["--version"], {
    env: input.environment,
  });
  if (pythonVersion === null) {
    throw new AutomationRuntimeError(
      "LANGUAGE_RUNTIME_UNAVAILABLE",
      "python3 is required to install Python automation dependencies on the worker.",
    );
  }

  const cacheKey = hashParts(["python", pythonVersion, requirements]);
  const finalDirectory = path.join(input.cacheRoot, "python", cacheKey);
  const created = await ensureCachedDirectory(finalDirectory, async () => {
    input.onLog?.(
      `swizzle: installing Python dependencies into ${input.cacheMode} cache ${cacheKey}\n`,
    );
    const tempRoot = await mkdtemp(path.join(input.cacheRoot, "python", `${cacheKey}.tmp-`));
    try {
      const venvDirectory = path.join(tempRoot, "venv");
      await runCommand("python3", ["-m", "venv", venvDirectory], {
        cwd: input.automationDirectory,
        env: input.environment,
      });
      await runCommand(
        path.join(venvDirectory, "bin", "python"),
        ["-m", "pip", "install", "--requirement", manifestPath],
        {
          cwd: input.automationDirectory,
          env: input.environment,
        },
      );
      await writeFile(
        path.join(tempRoot, "metadata.json"),
        `${JSON.stringify(
          {
            cacheKey,
            createdAt: new Date().toISOString(),
            kind: "python",
            pythonVersion,
            requirementsFile: input.requirementsFile,
          },
          null,
          2,
        )}\n`,
      );
      await rename(tempRoot, finalDirectory);
    } catch (error) {
      await rm(tempRoot, { force: true, recursive: true });
      throw error;
    }
  });

  if (!created) {
    input.onLog?.(`swizzle: Python dependency cache hit ${cacheKey}\n`);
  }

  const venvDirectory = path.join(finalDirectory, "venv");
  return {
    PATH: prependPathEntry(input.environment.PATH, path.join(venvDirectory, "bin")),
    VIRTUAL_ENV: venvDirectory,
  };
}

async function prepareNodeDependencies(input: {
  readonly automationDirectory: string;
  readonly cacheMode: "local" | "worker";
  readonly cacheRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly lockfile: string | null;
  readonly onLog?: (chunk: string) => void;
  readonly packageJson: string;
}): Promise<void> {
  const manifestPath = path.join(input.automationDirectory, input.packageJson);
  const manifest = await readRequiredFile(manifestPath, input.packageJson);
  const lockfileContent =
    input.lockfile !== null
      ? await readRequiredFile(path.join(input.automationDirectory, input.lockfile), input.lockfile)
      : "";
  const manager = resolveNodePackageManager(input.lockfile);
  const nodeVersion = process.version;
  const cacheKey = hashParts(["node", nodeVersion, manager.name, manifest, lockfileContent]);
  const finalDirectory = path.join(input.cacheRoot, "node", cacheKey);
  const nodeModulesPath = path.join(finalDirectory, "node_modules");
  const created = await ensureCachedDirectory(finalDirectory, async () => {
    input.onLog?.(
      `swizzle: installing Node dependencies into ${input.cacheMode} cache ${cacheKey}\n`,
    );
    const tempRoot = await mkdtemp(path.join(input.cacheRoot, "node", `${cacheKey}.tmp-`));
    try {
      await writeFile(path.join(tempRoot, "package.json"), manifest);
      if (input.lockfile !== null) {
        await writeFile(path.join(tempRoot, path.basename(input.lockfile)), lockfileContent);
      }
      await runCommand(manager.command, manager.args, {
        cwd: tempRoot,
        env: input.environment,
      });
      await writeFile(
        path.join(tempRoot, "metadata.json"),
        `${JSON.stringify(
          {
            cacheKey,
            createdAt: new Date().toISOString(),
            kind: "node",
            lockfile: input.lockfile,
            manager: manager.name,
            nodeVersion,
            packageJson: input.packageJson,
          },
          null,
          2,
        )}\n`,
      );
      await rename(tempRoot, finalDirectory);
    } catch (error) {
      await rm(tempRoot, { force: true, recursive: true });
      throw error;
    }
  });

  if (!created) {
    input.onLog?.(`swizzle: Node dependency cache hit ${cacheKey}\n`);
  }

  await linkOrCopyNodeModules(
    nodeModulesPath,
    path.join(input.automationDirectory, "node_modules"),
  );
}

async function hasDeployTimePackagedDependencies(automationDirectory: string): Promise<boolean> {
  try {
    const raw = await readFile(
      path.join(automationDirectory, ".swizzle", "build", "build-snapshot.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { format?: unknown; status?: unknown };
    return parsed.format !== "raw-source-v1" && parsed.status === "packaged";
  } catch {
    return false;
  }
}

async function ensureCachedDirectory(
  finalDirectory: string,
  build: () => Promise<void>,
): Promise<boolean> {
  if (await directoryExists(finalDirectory)) {
    await touchDirectory(finalDirectory);
    return false;
  }

  await mkdir(path.dirname(finalDirectory), { recursive: true });
  const lockDirectory = `${finalDirectory}.lock`;
  const lockStartedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDirectory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - lockStartedAt > LOCK_TIMEOUT_MS) {
        throw new AutomationRuntimeError(
          "DEPENDENCY_PACKAGING_FAILED",
          `Timed out waiting for dependency cache lock: ${lockDirectory}`,
        );
      }
      await sleep(LOCK_POLL_MS);
      if (await directoryExists(finalDirectory)) {
        await touchDirectory(finalDirectory);
        return false;
      }
    }
  }

  try {
    if (await directoryExists(finalDirectory)) {
      await touchDirectory(finalDirectory);
      return false;
    }
    await build();
    await touchDirectory(finalDirectory);
    return true;
  } finally {
    await rm(lockDirectory, { force: true, recursive: true });
  }
}

async function linkOrCopyNodeModules(source: string, destination: string): Promise<void> {
  if (!(await directoryExists(source))) {
    return;
  }
  await rm(destination, { force: true, recursive: true });
  try {
    await symlink(source, destination, "dir");
  } catch {
    await cp(source, destination, { force: true, recursive: true });
  }
}

async function pruneLanguageCache(languageDirectory: string): Promise<void> {
  let entries: { mtimeMs: number; path: string }[];
  try {
    entries = (
      await Promise.all(
        (
          await readdir(languageDirectory, { withFileTypes: true })
        ).map(async (entry) => {
          if (
            !entry.isDirectory() ||
            entry.name.endsWith(".lock") ||
            entry.name.includes(".tmp-")
          ) {
            return null;
          }
          const entryPath = path.join(languageDirectory, entry.name);
          const stats = await stat(entryPath);
          return { mtimeMs: stats.mtimeMs, path: entryPath };
        }),
      )
    ).filter((entry): entry is { mtimeMs: number; path: string } => entry !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const stale of entries
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(DEFAULT_CACHE_ENTRIES_PER_LANGUAGE)) {
    await rm(stale.path, { force: true, recursive: true });
  }
}

async function readRequiredFile(filePath: string, displayPath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutomationRuntimeError(
        "DEPENDENCY_MANIFEST_MISSING",
        `Declared dependency manifest was not found: ${displayPath}`,
      );
    }
    throw error;
  }
}

function resolveNodePackageManager(lockfile: string | null): {
  readonly args: readonly string[];
  readonly command: string;
  readonly name: "npm" | "pnpm";
} {
  const lockfileName = lockfile ? path.basename(lockfile) : null;
  if (lockfileName === "pnpm-lock.yaml") {
    return {
      args: ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"],
      command: "pnpm",
      name: "pnpm",
    };
  }

  if (lockfileName === "package-lock.json" || lockfileName === "npm-shrinkwrap.json") {
    return {
      args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      command: "npm",
      name: "npm",
    };
  }

  return {
    args: ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    command: "npm",
    name: "npm",
  };
}

async function detectCommandVersion(
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv },
): Promise<string | null> {
  try {
    const output = await runCommand(command, args, {
      cwd: process.cwd(),
      env: options.env,
      failureCode: null,
    });
    return extractVersionFromOutput(output);
  } catch {
    return null;
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly failureCode?: "DEPENDENCY_PACKAGING_FAILED" | null;
  },
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(
        new AutomationRuntimeError(
          options.failureCode ?? "DEPENDENCY_PACKAGING_FAILED",
          `Failed to start dependency command ${command}: ${getErrorMessage(error)}`,
        ),
      );
    });
    child.once("close", (exitCode) => {
      const combined = [stdout, stderr].filter((chunk) => chunk.length > 0).join("\n");
      if (exitCode !== 0) {
        reject(
          new AutomationRuntimeError(
            options.failureCode ?? "DEPENDENCY_PACKAGING_FAILED",
            `Dependency command failed (${command} ${args.join(" ")}): ${tail(combined) || `exit ${exitCode}`}`,
          ),
        );
        return;
      }

      resolve(combined);
    });
  });
}

function hashParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function extractVersionFromOutput(output: string): string | null {
  const match = output.match(/\bv?(\d+(?:\.\d+){0,3})\b/);
  return match?.[1] ?? null;
}

function prependPathEntry(existing: string | undefined, entry: string): string {
  return existing && existing.length > 0 ? `${entry}${path.delimiter}${existing}` : entry;
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const stats = await stat(directory);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function touchDirectory(directory: string): Promise<void> {
  try {
    const now = new Date();
    await utimes(directory, now, now);
  } catch {
    return;
  }
}

function tail(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= OUTPUT_TAIL_BYTES) {
    return output;
  }
  return output.slice(-OUTPUT_TAIL_BYTES);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
