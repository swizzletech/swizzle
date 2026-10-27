import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { AutomationRuntimeError, getErrorMessage } from "./errors.js";

export const SAMPLE_PAYLOAD_FILE_NAME = "sample-payload.json";

export interface PayloadInputOptions {
  readonly filePath?: string;
  readonly inlineJson?: string;
  readonly workingDirectory?: string;
}

export async function findSamplePayloadFile(
  automationDirectory: string,
): Promise<string | undefined> {
  const samplePayloadPath = path.resolve(automationDirectory, SAMPLE_PAYLOAD_FILE_NAME);
  const payloadStats = await stat(samplePayloadPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });

  if (!payloadStats?.isFile()) {
    return undefined;
  }

  return samplePayloadPath;
}

export async function loadPayload(options: PayloadInputOptions): Promise<unknown> {
  const { filePath, inlineJson, workingDirectory } = options;

  if (filePath && inlineJson) {
    throw new AutomationRuntimeError(
      "PAYLOAD_OPTIONS_CONFLICT",
      "Use either inline JSON payload or --payload-file, not both.",
    );
  }

  if (inlineJson) {
    try {
      return JSON.parse(inlineJson);
    } catch (error) {
      throw new AutomationRuntimeError(
        "INVALID_PAYLOAD_JSON",
        `Inline payload is not valid JSON: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  if (!filePath) {
    return {};
  }

  const resolvedFilePath = path.resolve(workingDirectory ?? process.cwd(), filePath);

  let fileContents: string;
  try {
    fileContents = await readFile(resolvedFilePath, "utf8");
  } catch (error) {
    throw new AutomationRuntimeError(
      "INVALID_PAYLOAD_FILE_JSON",
      `Could not read payload file: ${resolvedFilePath}`,
      { cause: error },
    );
  }

  try {
    return JSON.parse(fileContents);
  } catch (error) {
    throw new AutomationRuntimeError(
      "INVALID_PAYLOAD_FILE_JSON",
      `Payload file does not contain valid JSON: ${resolvedFilePath}. ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}
