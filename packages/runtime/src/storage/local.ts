import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDisplayName } from "@swizzle/core";
import { AutomationRuntimeError } from "../errors.js";
import type {
  ArtifactStorage,
  ArtifactStorageReference,
  ReadArtifactTextFileResult,
} from "./types.js";

export const DEFAULT_ARTIFACTS_DIRECTORY = path.join(".swizzle", "artifacts");

import { rethrowLocalArtifactStorageWriteError } from "./errors.js";
import {
  createArtifactManifest,
  createArtifactStorageReadinessFailure,
  toPosixPath,
  withMaterializedSource,
} from "./files.js";

export function createLocalArtifactStorage(options: {
  readonly artifactsDirectory?: string;
}): ArtifactStorage {
  const configuredArtifactsDirectory = options.artifactsDirectory
    ? path.resolve(options.artifactsDirectory)
    : undefined;
  const artifactsDirectory =
    configuredArtifactsDirectory ??
    path.resolve(path.join(process.cwd(), DEFAULT_ARTIFACTS_DIRECTORY));

  return {
    backend: "local",

    async checkReadiness() {
      const probePath = path.join(artifactsDirectory, `.swizzle-readiness-${randomUUID()}.probe`);
      const probeContents = randomUUID();
      let failure: unknown;

      try {
        await mkdir(artifactsDirectory, { recursive: true });
        await writeFile(probePath, probeContents, "utf8");
        if ((await readFile(probePath, "utf8")) !== probeContents) {
          throw new Error("Artifact storage readiness probe returned different contents.");
        }
      } catch (error) {
        failure = error;
      }

      try {
        await rm(probePath, { force: true });
      } catch (error) {
        failure ??= error;
      }

      return failure === undefined
        ? {
            backend: "local",
            ok: true,
            target: artifactsDirectory,
          }
        : createArtifactStorageReadinessFailure("local", artifactsDirectory, failure);
    },

    async createDeploymentArtifacts(input) {
      const relativeRootPath = toPosixPath(
        path.posix.join(createDisplayName(input.automationName), input.version, input.deploymentId),
      );
      const reference = buildLocalReference({
        artifactsDirectory,
        relativeRootPath,
      });

      try {
        await mkdir(reference.sourceDirectory, { recursive: true });
        for (const relativePath of input.includedFiles) {
          const sourcePath = path.join(input.automationDirectory, relativePath);
          const destinationPath = path.join(reference.sourceDirectory, relativePath);
          await mkdir(path.dirname(destinationPath), { recursive: true });
          await cp(sourcePath, destinationPath, { force: true });
        }

        await writeFile(
          reference.manifestPath,
          `${JSON.stringify(createArtifactManifest(input, reference), null, 2)}\n`,
          "utf8",
        );
      } catch (error) {
        rethrowLocalArtifactStorageWriteError(error, artifactsDirectory);
      }

      return reference;
    },

    async deleteAutomationArtifacts(automationName) {
      const slug = createDisplayName(automationName);
      await rm(path.join(artifactsDirectory, slug), { force: true, recursive: true });
    },

    async deleteDeploymentArtifacts(reference) {
      const resolved = resolveLocalReference(reference, configuredArtifactsDirectory);
      await rm(resolved.artifactRootPath, { force: true, recursive: true });
    },

    async exportDeploymentBundle(reference, targetDirectory) {
      const resolved = resolveLocalReference(reference, configuredArtifactsDirectory);
      await validateLocalDeployment(resolved);
      await rm(targetDirectory, { force: true, recursive: true });
      await mkdir(path.dirname(targetDirectory), { recursive: true });
      await cp(resolved.artifactRootPath, targetDirectory, { recursive: true });
      return resolved;
    },

    async exportStore(targetDirectory) {
      await mkdir(targetDirectory, { mode: 0o700 });
      let entries: string[];
      try {
        entries = await readdir(artifactsDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        await cp(path.join(artifactsDirectory, entry), path.join(targetDirectory, entry), {
          recursive: true,
        });
      }
    },

    async importDeploymentBundle(input) {
      if (input.locator.type !== "local") {
        throw new AutomationRuntimeError(
          "DEPLOYMENT_ARTIFACTS_MISSING",
          "Cannot restore a local deployment bundle from a non-local artifact locator.",
        );
      }

      const reference = buildLocalReference({
        artifactsDirectory,
        relativeRootPath: input.locator.relativeRootPath,
      });
      await rm(reference.artifactRootPath, { force: true, recursive: true });
      await mkdir(path.dirname(reference.artifactRootPath), { recursive: true });
      await cp(input.bundleDirectory, reference.artifactRootPath, { recursive: true });
      await validateLocalDeployment(reference);
      return reference;
    },

    async importStore(sourceDirectory) {
      // Empty the directory instead of replacing it: in the stack it is a volume mount point.
      await mkdir(artifactsDirectory, { recursive: true });
      for (const entry of await readdir(artifactsDirectory)) {
        await rm(path.join(artifactsDirectory, entry), { force: true, recursive: true });
      }
      await cp(sourceDirectory, artifactsDirectory, { recursive: true });
    },

    async withSourceDirectory(reference, use) {
      const resolved = resolveLocalReference(reference, configuredArtifactsDirectory);
      await validateLocalDeployment(resolved);
      return await withMaterializedSource(
        (directory) => cp(resolved.sourceDirectory, directory, { recursive: true }),
        use,
      );
    },

    async readTextFile(reference, relativePath) {
      const resolved = resolveLocalReference(reference, configuredArtifactsDirectory);
      const filePath = path.join(resolved.sourceDirectory, relativePath);

      try {
        return {
          content: await readFile(filePath, "utf8"),
          filePath,
        } satisfies ReadArtifactTextFileResult;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async validateDeploymentArtifacts(reference) {
      await validateLocalDeployment(resolveLocalReference(reference, configuredArtifactsDirectory));
    },
  } satisfies ArtifactStorage;
}

function buildLocalReference(input: {
  readonly artifactsDirectory: string;
  readonly relativeRootPath: string;
}): ArtifactStorageReference {
  const artifactRootPath = path.join(input.artifactsDirectory, input.relativeRootPath);
  return {
    artifactBackend: "local",
    artifactLocator: {
      artifactsDirectory: input.artifactsDirectory,
      relativeRootPath: input.relativeRootPath,
      type: "local",
    },
    artifactRootPath,
    manifestPath: path.join(artifactRootPath, "deployment.json"),
    sourceDirectory: path.join(artifactRootPath, "source"),
  };
}

function resolveLocalReference(
  reference: ArtifactStorageReference,
  artifactsDirectory?: string,
): ArtifactStorageReference {
  if (reference.artifactLocator.type !== "local") {
    return reference;
  }

  return buildLocalReference({
    artifactsDirectory: artifactsDirectory ?? reference.artifactLocator.artifactsDirectory,
    relativeRootPath: reference.artifactLocator.relativeRootPath,
  });
}

async function validateLocalDeployment(reference: ArtifactStorageReference): Promise<void> {
  try {
    await Promise.all([
      stat(reference.artifactRootPath),
      stat(reference.manifestPath),
      stat(reference.sourceDirectory),
    ]);
  } catch {
    throw new AutomationRuntimeError(
      "DEPLOYMENT_ARTIFACTS_MISSING",
      `Deployment artifacts not found at: ${reference.artifactRootPath}`,
    );
  }
}
