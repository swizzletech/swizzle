import path from "node:path";
import { AutomationRuntimeError } from "../errors.js";
import type { ArtifactStorageBackend } from "./types.js";

export function createArtifactStorageNotWritableError(
  backend: ArtifactStorageBackend,
  target: string,
  error: unknown,
): AutomationRuntimeError {
  const cause = error as NodeJS.ErrnoException & { readonly dest?: string };
  const identity = getProcessIdentity();
  const targetLabel = backend === "local" ? `at ${target}` : `in ${target}`;
  const operatorAction =
    backend === "local"
      ? "Ensure the mounted artifact volume is writable by the Swizzle runtime user (UID/GID 10001:10001)."
      : "Check the artifact bucket, prefix, credentials, and object write/delete permissions.";

  return new AutomationRuntimeError(
    "ARTIFACT_STORAGE_NOT_WRITABLE",
    `Artifact storage is not writable ${targetLabel}${identity ? ` by ${identity}` : ""}. ${operatorAction}`,
    {
      cause: error instanceof Error ? error : undefined,
      details: {
        backend,
        ...(cause.code !== undefined ? { causeCode: cause.code } : {}),
        ...(cause.syscall !== undefined ? { syscall: cause.syscall } : {}),
        target,
        ...(typeof process.getgid === "function" ? { gid: process.getgid() } : {}),
        ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
      },
    },
  );
}

function getProcessIdentity(): string | null {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return null;
  }
  return `uid=${process.getuid()} gid=${process.getgid()}`;
}

export function rethrowLocalArtifactStorageWriteError(
  error: unknown,
  artifactsDirectory: string,
): never {
  const cause = error as NodeJS.ErrnoException & { readonly dest?: string };
  const storageFailureCodes = new Set(["EACCES", "EDQUOT", "ENOSPC", "EPERM", "EROFS"]);
  const candidatePaths = [cause.path, cause.dest].filter(
    (candidate): candidate is string => typeof candidate === "string",
  );
  const belongsToArtifactRoot = candidatePaths.some((candidate) => {
    const relativePath = path.relative(artifactsDirectory, path.resolve(candidate));
    return (
      relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    );
  });

  if (cause.code !== undefined && storageFailureCodes.has(cause.code) && belongsToArtifactRoot) {
    throw createArtifactStorageNotWritableError("local", artifactsDirectory, error);
  }
  throw error;
}
