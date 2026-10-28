import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { scanStepSites, stepSourceLanguage } from "@swizzle/config";

import { AutomationRuntimeError } from "./errors.js";
import type { RuntimeReadinessReport } from "./platform-records.js";
import {
  type BuildSnapshot,
  createQueueNameForProfile,
  createRawSourceBuildSnapshot,
  createRuntimeSnapshot,
  type RuntimeSnapshot,
} from "./runtime-requirements.js";
import {
  type ArtifactLocator,
  type ArtifactStorageBackend,
  createConfiguredArtifactStorage,
} from "./storage.js";
import { type AutomationDefinition, loadAutomationDefinition } from "./validation.js";

const IGNORED_DIRECTORY_NAMES = new Set([
  ".swizzle",
  ".git",
  ".turbo",
  "__pycache__",
  "node_modules",
]);
const HASH_EXCLUDED_FILE_NAMES = new Set(["config.yaml", "config.yml"]);

export interface DeployAutomationOptions {
  readonly artifactsDirectory?: string;
  readonly automationDirectory: string;
  readonly deploymentId?: string;
  readonly skipReadinessCheck?: boolean;
}

export interface DeploymentArtifact {
  readonly artifactBackend: ArtifactStorageBackend;
  readonly artifactLocator: ArtifactLocator;
  readonly artifactRootPath: string;
  readonly buildSnapshot: BuildSnapshot;
  readonly definition: AutomationDefinition;
  readonly deployedAt: string;
  readonly deploymentId: string;
  readonly includedFiles: readonly string[];
  readonly manifestPath: string;
  readonly readiness: RuntimeReadinessReport;
  readonly runtimeSnapshot: RuntimeSnapshot;
  readonly sourceDirectory: string;
  readonly sourceHash: string;
}

export interface DeploymentCandidate {
  readonly definition: AutomationDefinition;
  readonly includedFiles: readonly string[];
  readonly readiness: RuntimeReadinessReport;
  readonly sourceHash: string;
}

interface HashedAutomationSource {
  readonly includedFiles: readonly string[];
  readonly sourceHash: string;
}

export async function inspectDeploymentCandidate(
  options: Pick<DeployAutomationOptions, "automationDirectory" | "skipReadinessCheck">,
): Promise<DeploymentCandidate> {
  const definition = await loadAutomationDefinition(options.automationDirectory);

  const hashedSource = await hashAutomationSource(definition.directory);
  if (hashedSource.includedFiles.length === 0) {
    throw new AutomationRuntimeError(
      "DEPLOYMENT_SOURCE_EMPTY",
      `Automation directory does not contain any deployable files: ${definition.directory}`,
    );
  }

  return {
    definition,
    includedFiles: hashedSource.includedFiles,
    readiness: createDeployReadinessSnapshot(definition),
    sourceHash: hashedSource.sourceHash,
  };
}

export async function deployAutomation(
  options: DeployAutomationOptions,
): Promise<DeploymentArtifact> {
  const candidate = await inspectDeploymentCandidate(options);
  const definition = candidate.definition;
  const deploymentId = options.deploymentId ?? randomUUID();
  const deployedAt = new Date().toISOString();

  const storage = createConfiguredArtifactStorage({
    ...(options.artifactsDirectory !== undefined
      ? { artifactsDirectory: options.artifactsDirectory }
      : {}),
  });
  const reference = await storage.createDeploymentArtifacts({
    config: definition.config,
    automationDirectory: definition.directory,
    automationName: definition.config.name,
    deployedAt,
    deploymentId,
    description: definition.config.description ?? null,
    entrypoint: definition.entrypointRelativePath,
    entrypointExtension: definition.entrypointExtension,
    includedFiles: candidate.includedFiles,
    sourceFormat: "raw-source-v1",
    sourceHash: candidate.sourceHash,
    triggerType: definition.config.trigger.type,
    version: definition.config.version,
  });

  const relativeEntrypoint = toPosixPath(
    path.relative(definition.directory, definition.entrypointPath),
  );
  const entrypoint = await storage.readTextFile(reference, relativeEntrypoint);
  if (entrypoint === null) throw new Error("The deployment artifact has no entrypoint.");
  const stepSites = scanStepSites(
    stepSourceLanguage(definition.config.runtime.language),
    entrypoint.content,
  );
  return {
    ...reference,
    buildSnapshot: createRawSourceBuildSnapshot(definition.config, stepSites),
    definition,
    deployedAt,
    deploymentId,
    includedFiles: candidate.includedFiles,
    readiness: candidate.readiness,
    runtimeSnapshot: createRuntimeSnapshot(definition.config),
    sourceHash: candidate.sourceHash,
  };
}

function createDeployReadinessSnapshot(definition: AutomationDefinition): RuntimeReadinessReport {
  const runtimeSnapshot = createRuntimeSnapshot(definition.config);

  return {
    availableProfiles: [],
    checkedAt: new Date().toISOString(),
    compatibleWorkerInstanceIds: [],
    errors: [],
    executionMode: runtimeSnapshot.execution_mode,
    language: runtimeSnapshot.language,
    matchingWorkerCount: 0,
    profile: runtimeSnapshot.profile,
    queueName: createQueueNameForProfile(runtimeSnapshot.profile),
    status: "ready",
    warnings: [],
  };
}

async function hashAutomationSource(automationDirectory: string): Promise<HashedAutomationSource> {
  const includedFiles = await collectSourceFiles(automationDirectory);
  const hash = createHash("sha256");

  for (const relativePath of includedFiles) {
    const filePath = path.join(automationDirectory, relativePath);
    const fileContents = await readFile(filePath);

    if (!HASH_EXCLUDED_FILE_NAMES.has(path.basename(relativePath))) {
      hash.update(relativePath);
      hash.update("\0");
      hash.update(fileContents);
      hash.update("\0");
    }
  }

  return {
    includedFiles,
    sourceHash: hash.digest("hex"),
  };
}

async function collectSourceFiles(
  directory: string,
  currentRelativeDirectory = "",
): Promise<string[]> {
  const absoluteDirectory = path.join(directory, currentRelativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const discoveredFiles: string[] = [];

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = currentRelativeDirectory
      ? path.join(currentRelativeDirectory, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }

      discoveredFiles.push(...(await collectSourceFiles(directory, relativePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const normalizedRelativePath = toPosixPath(relativePath);
    const absoluteFilePath = path.join(directory, relativePath);
    const fileStats = await stat(absoluteFilePath);

    if (!fileStats.isFile()) {
      continue;
    }

    discoveredFiles.push(normalizedRelativePath);
  }

  return discoveredFiles;
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join(path.posix.sep);
}
