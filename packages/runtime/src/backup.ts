// One backup per directory: metadata.json, database.sql and artifacts/ at its root.
// An export stages the whole directory privately and publishes it with one rename, so a
// destination either does not exist or holds one complete backup. A destination is written once.
import { chmod, lstat, open, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactStorageBackend } from "./storage.js";

export interface BackupMetadata {
  readonly artifactBackend: ArtifactStorageBackend;
  readonly createdAt: string;
  readonly formatVersion: 1;
}

/** The fixed layout of a backup directory. */
export interface BackupPaths {
  readonly artifactsDirectory: string;
  readonly databaseDump: string;
  readonly metadataFile: string;
}

export class BackupError extends Error {
  readonly code:
    | "BACKUP_DESTINATION_EXISTS"
    | "BACKUP_INCOMPLETE"
    | "BACKUP_METADATA_INVALID"
    | "BACKUP_METADATA_MISSING"
    | "BACKUP_OUTPUT_SYMLINK";
  readonly hint: string;

  constructor(code: BackupError["code"], message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function backupPaths(directory: string): BackupPaths {
  return {
    artifactsDirectory: path.join(directory, "artifacts"),
    databaseDump: path.join(directory, "database.sql"),
    metadataFile: path.join(directory, "metadata.json"),
  };
}

export function createBackupMetadata(artifactBackend: ArtifactStorageBackend): BackupMetadata {
  return { artifactBackend, createdAt: new Date().toISOString(), formatVersion: 1 };
}

/** Throws BACKUP_DESTINATION_EXISTS unless the directory is missing or an empty directory. */
export async function assertBackupDestinationFree(destination: string): Promise<void> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(destination);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (entry.isDirectory() && (await readdir(destination)).length === 0) return;
  throw destinationExists(destination);
}

/** Reads metadata.json and checks the dump and artifact directory exist: a complete backup. */
export async function readBackup(directory: string): Promise<BackupMetadata> {
  const paths = backupPaths(directory);
  let text: string;
  try {
    text = await readFile(paths.metadataFile, "utf8");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    throw new BackupError(
      "BACKUP_METADATA_MISSING",
      `Not a backup: ${paths.metadataFile} does not exist.`,
      "Point --input-dir at a directory written by `swizzle backup export` or `just backup`.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("formatVersion" in raw) ||
    raw.formatVersion !== 1 ||
    !("artifactBackend" in raw) ||
    (raw.artifactBackend !== "local" && raw.artifactBackend !== "s3") ||
    !("createdAt" in raw) ||
    typeof raw.createdAt !== "string"
  ) {
    throw new BackupError(
      "BACKUP_METADATA_INVALID",
      `Invalid backup metadata in ${paths.metadataFile}`,
      "Export a fresh backup with `swizzle backup export`.",
    );
  }
  const complete =
    (await stat(paths.databaseDump).catch(() => null))?.isFile() === true &&
    (await stat(paths.artifactsDirectory).catch(() => null))?.isDirectory() === true;
  if (!complete) {
    throw new BackupError(
      "BACKUP_INCOMPLETE",
      `Incomplete backup in ${directory}: it needs database.sql and artifacts/ beside metadata.json.`,
      "Export a fresh backup with `swizzle backup export`.",
    );
  }
  return { artifactBackend: raw.artifactBackend, createdAt: raw.createdAt, formatVersion: 1 };
}

/**
 * Makes the staged tree owner-only, rejects symbolic links, flushes every file and directory to
 * disk and rejects an incomplete backup. Then it renames the tree to the destination and flushes
 * the parent directory. The rename is the commit: a crash or power loss before it leaves no
 * destination, and after it the destination holds the flushed tree. The rename refuses a
 * destination that gained content since the check.
 */
export async function publishBackup(staging: string, destination: string): Promise<void> {
  await sealTree(staging);
  await readBackup(staging);
  try {
    await rename(staging, destination);
  } catch (error) {
    if (isErrno(error, "ENOTEMPTY") || isErrno(error, "EEXIST") || isErrno(error, "ENOTDIR"))
      throw destinationExists(destination);
    throw error;
  }
  await syncToDisk(path.dirname(destination));
}

// Children are flushed before the directory that names them, so a flushed directory never
// names an entry whose data is still in the page cache.
async function sealTree(target: string): Promise<void> {
  const entry = await lstat(target);
  if (entry.isSymbolicLink()) {
    throw new BackupError(
      "BACKUP_OUTPUT_SYMLINK",
      `A backup must not contain symbolic links: ${target}`,
      "Remove the symbolic link from the artifact store, then export again.",
    );
  }
  await chmod(target, entry.isDirectory() ? 0o700 : 0o600);
  if (entry.isDirectory())
    for (const name of await readdir(target)) await sealTree(path.join(target, name));
  await syncToDisk(target);
}

async function syncToDisk(target: string): Promise<void> {
  // Windows cannot open a directory, so it cannot flush one either.
  if (process.platform === "win32" && (await stat(target)).isDirectory()) return;
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function destinationExists(destination: string): BackupError {
  const stamp = new Date().toISOString().slice(0, 16).replace(":", "-");
  return new BackupError(
    "BACKUP_DESTINATION_EXISTS",
    `Backup destination is taken: ${destination} exists and is not an empty directory. Each backup is written once into a directory of its own.`,
    `Choose a new directory, for example one named by date: ${path.join(path.dirname(destination), stamp)}`,
  );
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// `just backup` runs `check <destination>` before the export and `publish <staging> <destination>`
// after it, with Node alone, without loading the workspace graph.
async function runRecipeStep(args: readonly string[]): Promise<void> {
  const [command, first, second] = args;
  if (command === "check" && first) return assertBackupDestinationFree(first);
  if (command === "publish" && first && second) return publishBackup(first, second);
  throw new Error("Usage: backup.ts check <destination> | publish <staging> <destination>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runRecipeStep(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof BackupError) console.error(error.hint);
    process.exitCode = 1;
  });
}
