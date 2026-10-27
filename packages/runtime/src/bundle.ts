import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type Message as EsbuildMessage, build as esbuildBuild } from "esbuild";
import { create as tarCreate } from "tar";

const IGNORED_DIRECTORY_NAMES = new Set([
  ".swizzle",
  ".git",
  ".turbo",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "venv",
]);

const IGNORED_FILE_NAMES = new Set([".DS_Store"]);
const HASH_EXCLUDED_FILE_NAMES = new Set(["config.yaml", "config.yml"]);

const DEFAULT_MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

export interface PackAutomationOptions {
  readonly maxBundleBytes?: number;
}

export interface BundleEntrypointDryRunOptions {
  readonly language: "node" | "typescript";
  readonly outputFormat: "cjs" | "esm";
  readonly path: string;
}

export interface PackedAutomationBundle {
  readonly bundle: Buffer;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly fileCount: number;
  readonly includedFiles: readonly string[];
}

export class BundleTooLargeError extends Error {
  readonly byteSize: number;
  readonly limitBytes: number;

  constructor(byteSize: number, limitBytes: number) {
    super(
      `Bundle exceeds ${limitBytes} bytes (observed ${byteSize}). ` +
        "Exclude unused files (node_modules, build output) or add an .swizzleignore.",
    );
    this.byteSize = byteSize;
    this.limitBytes = limitBytes;
  }
}

export class BundleEmptyError extends Error {
  constructor(directory: string) {
    super(`No files to include in bundle: ${directory}`);
  }
}

export async function bundleEntrypointDryRun(
  options: BundleEntrypointDryRunOptions,
): Promise<{ ok: true } | { errors: string[]; ok: false }> {
  const resolvedPath = path.resolve(options.path);

  try {
    await esbuildBuild({
      absWorkingDir: path.dirname(resolvedPath),
      bundle: true,
      entryPoints: [resolvedPath],
      external: ["*"],
      format: options.outputFormat,
      legalComments: "none",
      logLevel: "silent",
      platform: "node",
      target: "node26",
      write: false,
    });
    return { ok: true };
  } catch (error) {
    if (typeof error === "object" && error !== null && "errors" in error) {
      const errors = Array.isArray(error.errors)
        ? error.errors.map((message) => formatEsbuildMessage(message as EsbuildMessage))
        : [error instanceof Error ? error.message : String(error)];
      return { errors, ok: false };
    }

    throw error;
  }
}

/**
 * Collect the list of files under `directory` that should be part of the
 * deployment bundle, honouring the shared ignore set with the runtime package.
 * Returned paths are relative to `directory` and use POSIX separators.
 */
export async function collectBundleFiles(directory: string): Promise<string[]> {
  const resolved = path.resolve(directory);
  return walk(resolved, "");
}

async function walk(root: string, relative: string): Promise<string[]> {
  const absolute = path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries.toSorted((l, r) => l.name.localeCompare(r.name))) {
    const entryRelative = relative ? path.posix.join(relative, entry.name) : entry.name;

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      result.push(...(await walk(root, entryRelative)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (IGNORED_FILE_NAMES.has(entry.name)) {
      continue;
    }

    result.push(entryRelative);
  }

  return result;
}

/**
 * Pack an automation folder into a deterministic tar.gz bundle ready for upload
 * to the platform API. Produces the source hash that the API would compute for
 * deployment identity, so callers can display it without extra roundtrips.
 */
export async function packAutomation(
  automationDirectory: string,
  options: PackAutomationOptions = {},
): Promise<PackedAutomationBundle> {
  const maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  const resolvedDir = path.resolve(automationDirectory);

  const stats = await stat(resolvedDir);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${resolvedDir}`);
  }

  const includedFiles = await collectBundleFiles(resolvedDir);
  if (includedFiles.length === 0) {
    throw new BundleEmptyError(resolvedDir);
  }

  const contentHash = await computeContentHash(resolvedDir, includedFiles);

  const tarStream = tarCreate(
    {
      cwd: resolvedDir,
      gzip: { level: 6 },
      portable: true,
      // `noMtime` makes tar contents independent of filesystem mtimes so that
      // bundles for the same logical input are byte-identical.
      noMtime: true,
    },
    [...includedFiles],
  );

  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of tarStream as AsyncIterable<Buffer>) {
    byteSize += chunk.length;
    if (byteSize > maxBundleBytes) {
      tarStream.destroy();
      throw new BundleTooLargeError(byteSize, maxBundleBytes);
    }
    chunks.push(chunk);
  }

  const bundle = Buffer.concat(chunks);
  return {
    bundle,
    byteSize: bundle.length,
    contentHash,
    fileCount: includedFiles.length,
    includedFiles,
  };
}

async function computeContentHash(root: string, relativeFiles: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of [...relativeFiles].toSorted((a, b) => a.localeCompare(b))) {
    if (HASH_EXCLUDED_FILE_NAMES.has(path.basename(relativePath))) {
      continue;
    }
    const filePath = path.join(root, relativePath);
    const content = await readFile(filePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function formatEsbuildMessage(message: EsbuildMessage): string {
  const location = message.location;
  const prefix =
    location !== null && location !== undefined
      ? `${location.file}:${location.line}:${location.column}: `
      : "";
  const notes = message.notes.map((note) => note.text).filter((note) => note.length > 0);
  return `${prefix}${message.text}${notes.length > 0 ? ` (${notes.join(" ")})` : ""}`;
}
