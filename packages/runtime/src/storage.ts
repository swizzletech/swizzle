import path from "node:path";

import { AutomationRuntimeError } from "./errors.js";
import { createLocalArtifactStorage, DEFAULT_ARTIFACTS_DIRECTORY } from "./storage/local.js";
import { createS3ArtifactStorage, createS3ReadinessTarget } from "./storage/s3.js";
import type {
  ArtifactStorage,
  ArtifactStorageBackend,
  ArtifactStorageReadinessResult,
  ArtifactStorageReference,
  CreateArtifactStorageOptions,
} from "./storage/types.js";

const DEFAULT_S3_REGION = "us-east-1";

export function createConfiguredArtifactStorage(
  options: CreateArtifactStorageOptions = {},
): ArtifactStorage {
  const environment = options.environment ?? process.env;
  const backend = normalizeArtifactBackend(environment.SWIZZLE_ARTIFACT_BACKEND);

  if (backend === "local") {
    const artifactsDirectory = options.artifactsDirectory ?? environment.SWIZZLE_ARTIFACTS_DIR;
    return createLocalArtifactStorage(
      artifactsDirectory !== undefined ? { artifactsDirectory } : {},
    );
  }

  return createS3ArtifactStorage({
    bucket: requiredEnvironmentValue(environment, "SWIZZLE_ARTIFACT_S3_BUCKET"),
    endpoint: normalizeOptionalString(environment.SWIZZLE_ARTIFACT_S3_ENDPOINT),
    forcePathStyle: parseBoolean(environment.SWIZZLE_ARTIFACT_S3_FORCE_PATH_STYLE),
    prefix: normalizeOptionalPathPrefix(environment.SWIZZLE_ARTIFACT_S3_PREFIX),
    region: normalizeOptionalString(environment.SWIZZLE_ARTIFACT_S3_REGION) ?? DEFAULT_S3_REGION,
  });
}

export async function checkConfiguredArtifactStorageReadiness(
  options: CreateArtifactStorageOptions = {},
): Promise<ArtifactStorageReadinessResult> {
  try {
    return await createConfiguredArtifactStorage(options).checkReadiness();
  } catch (error) {
    const environment = options.environment ?? process.env;
    const backend =
      environment.SWIZZLE_ARTIFACT_BACKEND?.trim().toLowerCase() === "s3" ? "s3" : "local";
    const target =
      backend === "s3"
        ? createS3ReadinessTarget(
            environment.SWIZZLE_ARTIFACT_S3_BUCKET?.trim() || "<unconfigured>",
            normalizeOptionalPathPrefix(environment.SWIZZLE_ARTIFACT_S3_PREFIX),
          )
        : path.resolve(
            options.artifactsDirectory ??
              environment.SWIZZLE_ARTIFACTS_DIR ??
              path.join(process.cwd(), DEFAULT_ARTIFACTS_DIRECTORY),
          );
    return {
      backend,
      code: "ARTIFACT_STORAGE_NOT_WRITABLE",
      error:
        error instanceof AutomationRuntimeError
          ? error.message
          : "Artifact storage configuration could not be initialized.",
      ok: false,
      target,
    };
  }
}

/**
 * Names the tree that deleting a reference's artifacts removes. Deployments with
 * the same key share one tree: a rollback copies its target's locator.
 */
export function getArtifactTreeKey(reference: ArtifactStorageReference): string {
  const locator = reference.artifactLocator;
  return locator.type === "s3"
    ? `s3:${locator.bucket}/${locator.keyPrefix}`
    : `local:${locator.relativeRootPath}`;
}

export function createArtifactStorageForReference(
  reference: ArtifactStorageReference,
  options: CreateArtifactStorageOptions = {},
): ArtifactStorage {
  const locator = reference.artifactLocator;
  if (locator.type === "s3") {
    const environment = options.environment ?? process.env;
    return createS3ArtifactStorage({
      bucket: locator.bucket,
      endpoint:
        locator.endpoint ?? normalizeOptionalString(environment.SWIZZLE_ARTIFACT_S3_ENDPOINT),
      forcePathStyle: locator.forcePathStyle,
      prefix: normalizeOptionalPathPrefix(environment.SWIZZLE_ARTIFACT_S3_PREFIX),
      region: locator.region,
    });
  }

  const artifactsDirectory =
    options.artifactsDirectory ?? (options.environment ?? process.env).SWIZZLE_ARTIFACTS_DIR;
  return createLocalArtifactStorage(artifactsDirectory !== undefined ? { artifactsDirectory } : {});
}

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeOptionalPathPrefix(value: string | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.replace(/^\/+|\/+$/g, "") : null;
}

function normalizeArtifactBackend(value: string | undefined): ArtifactStorageBackend {
  const normalized = value?.trim().toLowerCase() || "local";
  if (normalized === "local" || normalized === "s3") {
    return normalized;
  }

  throw new AutomationRuntimeError(
    "AUTOMATION_CONFIG_INVALID",
    `Unsupported artifact backend: ${value}`,
  );
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      `Missing required environment variable for artifact storage: ${name}`,
    );
  }

  return value;
}

function parseBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export type {
  ArtifactLocator,
  ArtifactStorage,
  ArtifactStorageBackend,
  ArtifactStorageReadinessResult,
  ArtifactStorageReference,
  CreateArtifactStorageOptions,
} from "./storage/types.js";
