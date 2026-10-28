import type { AutomationConfig } from "@swizzle/config";

export type ArtifactStorageBackend = "local" | "s3";

interface LocalArtifactLocator {
  readonly artifactsDirectory: string;
  readonly relativeRootPath: string;
  readonly type: "local";
}

export interface S3ArtifactLocator {
  readonly bucket: string;
  readonly endpoint: string | null;
  readonly forcePathStyle: boolean;
  readonly keyPrefix: string;
  readonly region: string;
  readonly type: "s3";
}

export type ArtifactLocator = LocalArtifactLocator | S3ArtifactLocator;

export interface ArtifactStorageReference {
  readonly artifactBackend: ArtifactStorageBackend;
  readonly artifactLocator: ArtifactLocator;
  readonly artifactRootPath: string;
  readonly manifestPath: string;
  readonly sourceDirectory: string;
}

export interface CreateDeploymentArtifactsInput {
  readonly config: AutomationConfig;
  readonly automationDirectory: string;
  readonly automationName: string;
  readonly deployedAt: string;
  readonly deploymentId: string;
  readonly description?: string | null;
  readonly entrypoint: string;
  readonly entrypointExtension: string;
  readonly includedFiles: readonly string[];
  readonly sourceFormat?: "raw-source-v1" | undefined;
  readonly sourceHash: string;
  readonly triggerType: "chain" | "cron" | "webhook";
  readonly version: string;
}

export interface ReadArtifactTextFileResult {
  readonly content: string;
  readonly filePath: string | null;
}

export interface ArtifactStorageReadinessResult {
  readonly backend: ArtifactStorageBackend;
  readonly code?: "ARTIFACT_STORAGE_NOT_WRITABLE";
  readonly error?: string;
  readonly ok: boolean;
  readonly target: string;
}

export interface ArtifactStorage {
  readonly backend: ArtifactStorageBackend;
  checkReadiness(): Promise<ArtifactStorageReadinessResult>;
  createDeploymentArtifacts(
    input: CreateDeploymentArtifactsInput,
  ): Promise<ArtifactStorageReference>;
  deleteAutomationArtifacts(automationName: string): Promise<void>;
  deleteDeploymentArtifacts(reference: ArtifactStorageReference): Promise<void>;
  exportDeploymentBundle(
    reference: ArtifactStorageReference,
    targetDirectory: string,
  ): Promise<ArtifactStorageReference>;
  /** Creates a private export destination; refuses an existing path without changing it. */
  exportStore(targetDirectory: string): Promise<void>;
  importDeploymentBundle(input: {
    readonly bundleDirectory: string;
    readonly locator: ArtifactLocator;
  }): Promise<ArtifactStorageReference>;
  importStore(sourceDirectory: string): Promise<void>;
  /** Owns the private source copy through copy failure, use, and cleanup. */
  withSourceDirectory<T>(
    reference: ArtifactStorageReference,
    use: (directory: string) => Promise<T>,
  ): Promise<T>;
  readTextFile(
    reference: ArtifactStorageReference,
    relativePath: string,
  ): Promise<ReadArtifactTextFileResult | null>;
  validateDeploymentArtifacts(reference: ArtifactStorageReference): Promise<void>;
}

export interface CreateArtifactStorageOptions {
  readonly artifactsDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}
