import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "../../../test/support.js";

/**
 * Fixtures for the platform test files; test/support.ts holds what every test file shares.
 * Build an automation with createAutomationFixture().
 */

export const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const repoRoot = path.resolve(packageRoot, "../..");

export async function createAutomationFixture(input: {
  readonly configLines?: readonly string[];
  readonly mainJs?: string;
  readonly name: string;
  readonly triggerLines: readonly string[];
}): Promise<string> {
  const automationDirectory = await temporaryDirectory("swizzle-fixture-");
  await writeFile(
    path.join(automationDirectory, "config.yaml"),
    [
      `name: ${input.name}`,
      "version: 1.0.0",
      "entrypoint: main.js",
      "trigger:",
      ...input.triggerLines,
      ...(input.configLines ?? []),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(automationDirectory, "main.js"),
    input.mainJs ?? ["console.log(JSON.stringify({ ok: true }));", ""].join("\n"),
    "utf8",
  );

  return automationDirectory;
}
