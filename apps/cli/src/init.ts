import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLE_PAYLOAD_FILE_NAME } from "@swizzle/runtime";

import { AgentError, EXIT_CODES } from "./output.js";

import {
  buildTemplateFiles,
  createAutomationSlug,
  createScaffoldTrigger,
  type InitTemplateId,
  resolveScaffoldSelection,
  type ScaffoldPatternId,
  type ScaffoldTrigger,
  templateCheckFile,
} from "./scaffolds.js";

interface CreateAutomationScaffoldOptions {
  readonly pattern?: ScaffoldPatternId;
  readonly targetDirectory: string;
  readonly template?: InitTemplateId;
}

export interface CreatedAutomationScaffold {
  readonly absoluteTargetDirectory: string;
  readonly automationName: string;
  readonly checkFile: string;
  readonly createdFiles: readonly string[];
  readonly pattern: ScaffoldPatternId;
  readonly samplePayloadPath: string;
  readonly template: InitTemplateId;
  readonly trigger: ScaffoldTrigger;
}

export async function createAutomationScaffold(
  options: CreateAutomationScaffoldOptions,
): Promise<CreatedAutomationScaffold> {
  const absoluteTargetDirectory = path.resolve(options.targetDirectory);
  await ensureWritableTargetDirectory(absoluteTargetDirectory);

  const automationName = createAutomationSlug(path.basename(absoluteTargetDirectory));
  const selection = resolveScaffoldSelection({
    ...(options.pattern !== undefined ? { pattern: options.pattern } : {}),
    ...(options.template !== undefined ? { template: options.template } : {}),
  });
  const trigger = createScaffoldTrigger(selection, automationName);
  const templateFiles = await buildTemplateFiles({
    automationName,
    selection,
    targetDirectory: absoluteTargetDirectory,
    trigger,
  });

  await Promise.all(
    templateFiles.map(async ({ filePath, content }) => {
      await writeFile(filePath, content, "utf8");
    }),
  );

  return {
    absoluteTargetDirectory,
    automationName,
    checkFile: templateCheckFile(selection.template),
    createdFiles: templateFiles.map(({ filePath }) =>
      path.relative(absoluteTargetDirectory, filePath),
    ),
    pattern: selection.pattern,
    samplePayloadPath: path.join(absoluteTargetDirectory, SAMPLE_PAYLOAD_FILE_NAME),
    template: selection.template,
    trigger,
  };
}

async function ensureWritableTargetDirectory(targetDirectory: string): Promise<void> {
  const existing = await stat(targetDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });

  if (existing) {
    if (!existing.isDirectory() || (await readdir(targetDirectory)).length > 0) {
      throw new AgentError({
        code: "INIT_TARGET_NOT_EMPTY",
        exitCode: EXIT_CODES.conflict,
        hint: "Pass a new directory; init never writes into one that holds files.",
        message: `${targetDirectory} already exists and is ${existing.isDirectory() ? "not empty" : "not a directory"}.`,
      });
    }

    return;
  }

  await mkdir(targetDirectory, { recursive: true });
}
