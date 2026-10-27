import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type AutomationConfig, parseAutomationConfig } from "@swizzle/config";

import { AutomationRuntimeError, getErrorMessage } from "./errors.js";

const SUPPORTED_ENTRYPOINT_EXTENSIONS = [".py", ".js", ".ts"] as const;

type SupportedEntrypointExtension = (typeof SUPPORTED_ENTRYPOINT_EXTENSIONS)[number];

export interface AutomationDefinition {
  readonly directory: string;
  readonly config: AutomationConfig;
  readonly configPath: string;
  readonly entrypointExtension: SupportedEntrypointExtension;
  readonly entrypointPath: string;
  readonly entrypointRelativePath: string;
}

export async function loadAutomationDefinition(
  automationDirectory: string,
): Promise<AutomationDefinition> {
  const directory = path.resolve(automationDirectory);
  const configPath = path.join(directory, "config.yaml");

  let configSource: string;
  try {
    configSource = await readFile(configPath, "utf8");
  } catch (error) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_NOT_FOUND",
      `No config.yaml found in automation directory: ${directory}`,
      { cause: error },
    );
  }

  let config: AutomationConfig;
  try {
    config = parseAutomationConfig(configSource);
  } catch (error) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      `Invalid config.yaml in ${directory}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  const entrypointPath = path.resolve(directory, config.entrypoint);
  if (!isPathInside(directory, entrypointPath)) {
    throw new AutomationRuntimeError(
      "AUTOMATION_ENTRYPOINT_OUTSIDE_DIRECTORY",
      `Entrypoint must stay inside the automation directory: ${config.entrypoint}`,
    );
  }

  const entrypointExtension = path
    .extname(entrypointPath)
    .toLowerCase() as SupportedEntrypointExtension;
  if (!SUPPORTED_ENTRYPOINT_EXTENSIONS.includes(entrypointExtension)) {
    throw new AutomationRuntimeError(
      "AUTOMATION_ENTRYPOINT_UNSUPPORTED",
      `Unsupported entrypoint type "${path.extname(entrypointPath) || config.entrypoint}". Supported types: ${SUPPORTED_ENTRYPOINT_EXTENSIONS.join(", ")}`,
    );
  }

  const entrypointStats = await stat(entrypointPath).catch((error) => {
    throw new AutomationRuntimeError(
      "AUTOMATION_ENTRYPOINT_NOT_FOUND",
      `Entrypoint file '${config.entrypoint}' not found in bundle. Check \`entrypoint:\` in config.yaml and that the file is not excluded by .swizzleignore.`,
      { cause: error, details: { entrypoint: config.entrypoint } },
    );
  });

  if (!entrypointStats.isFile()) {
    throw new AutomationRuntimeError(
      "AUTOMATION_ENTRYPOINT_NOT_FOUND",
      `Entrypoint '${config.entrypoint}' exists but is not a file. Update \`entrypoint:\` in config.yaml to point at the automation's main script.`,
      { details: { entrypoint: config.entrypoint } },
    );
  }

  const definition: AutomationDefinition = {
    directory,
    config,
    configPath,
    entrypointExtension,
    entrypointPath,
    entrypointRelativePath: config.entrypoint,
  };
  if (config.api_check?.mode === "active") {
    const check = activeApiCheck(definition);
    const checkStats = await stat(check.path).catch(() => null);
    if (checkStats === null || !checkStats.isFile()) {
      throw new AutomationRuntimeError(
        "AUTOMATION_ENTRYPOINT_NOT_FOUND",
        `API check file '${check.relativePath}' not found in bundle. api_check.mode is active, so create it (\`swizzle init\` scaffolds a check stub) or set api_check.entrypoint.`,
        { details: { entrypoint: check.relativePath } },
      );
    }
  }
  return definition;
}

/**
 * The API check of an automation with `api_check.mode: active`: the script that runs in place of
 * the entrypoint, and the secrets it receives (all declared secrets unless it names a subset).
 */
export function activeApiCheck(definition: AutomationDefinition): {
  readonly path: string;
  readonly relativePath: string;
  readonly secrets: readonly string[];
} {
  const apiCheck = definition.config.api_check;
  if (apiCheck?.mode !== "active") {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      `${definition.config.name} has no API check to run: set api_check.mode to active in config.yaml.`,
    );
  }
  const checkPath = path.resolve(definition.directory, apiCheck.entrypoint);
  if (!isPathInside(definition.directory, checkPath)) {
    throw new AutomationRuntimeError(
      "AUTOMATION_ENTRYPOINT_OUTSIDE_DIRECTORY",
      `api_check.entrypoint must stay inside the automation directory: ${apiCheck.entrypoint}`,
    );
  }
  return {
    path: checkPath,
    relativePath: apiCheck.entrypoint,
    secrets: apiCheckSecretNames(definition.config),
  };
}

/** The secrets an active API check receives: the subset it names, else every declared secret. */
export function apiCheckSecretNames(config: {
  readonly api_check?: AutomationConfig["api_check"];
  readonly secrets: readonly string[];
}): readonly string[] {
  return (
    (config.api_check?.mode === "active" ? config.api_check.secrets : undefined) ?? config.secrets
  );
}

function isPathInside(parentDirectory: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentDirectory, candidatePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
