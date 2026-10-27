import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createArtifactStorageNotWritableError } from "./errors.js";
import type {
  ArtifactStorageBackend,
  ArtifactStorageReadinessResult,
  ArtifactStorageReference,
  CreateDeploymentArtifactsInput,
} from "./types.js";

export function createArtifactManifest(
  input: CreateDeploymentArtifactsInput,
  reference: ArtifactStorageReference,
): Record<string, unknown> {
  return {
    artifactBackend: reference.artifactBackend,
    artifactLocator: reference.artifactLocator,
    artifactsDirectory:
      reference.artifactLocator.type === "local"
        ? reference.artifactLocator.artifactsDirectory
        : null,
    automation: {
      description: input.description ?? null,
      entrypoint: input.entrypoint,
      entrypointExtension: input.entrypointExtension,
      name: input.automationName,
      triggerType: input.triggerType,
      version: input.version,
    },
    deployedAt: input.deployedAt,
    deploymentId: input.deploymentId,
    fileCount: input.includedFiles.length,
    files: input.includedFiles,
    sourceFormat: input.sourceFormat ?? "packaged-source-v1",
    sourceHash: input.sourceHash,
  };
}

export function createArtifactStorageReadinessFailure(
  backend: ArtifactStorageBackend,
  target: string,
  error: unknown,
): ArtifactStorageReadinessResult {
  const runtimeError = createArtifactStorageNotWritableError(backend, target, error);
  return {
    backend,
    code: "ARTIFACT_STORAGE_NOT_WRITABLE",
    error: runtimeError.message,
    ok: false,
    target,
  };
}

export async function collectFilesRecursively(
  directory: string,
  currentRelativeDirectory = "",
): Promise<string[]> {
  const absoluteDirectory = path.join(directory, currentRelativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = currentRelativeDirectory
      ? path.join(currentRelativeDirectory, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursively(directory, relativePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(toPosixPath(relativePath));
    }
  }

  return files;
}

export function toPosixPath(input: string): string {
  return input.split(path.sep).join(path.posix.sep);
}

/** Allocation and every operation that can fail live under the same cleanup owner. */
export async function withMaterializedSource<T>(
  copy: (directory: string) => Promise<void>,
  use: (directory: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "swizzle-artifact-"));
  try {
    const directory = path.join(root, "source");
    await mkdir(directory);
    await copy(directory);
    return await use(directory);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
