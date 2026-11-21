import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { temporaryDirectory } from "../../test/support.js";
import { lint } from "./lint.js";
import { readRepo } from "./repo.js";
import { rules } from "./rules.js";

export async function findingsFor(ruleId: string, files: Record<string, string>) {
  const rule = rules.find((candidate) => candidate.id === ruleId);
  if (rule === undefined) throw new Error(`rules.ts lists no rule ${ruleId}`);
  const root = await temporaryDirectory("swizzle-conventions-");
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return lint(readRepo(root, Object.keys(files)), [rule]);
}

export async function reported(ruleId: string, files: Record<string, string>): Promise<string[]> {
  return (await findingsFor(ruleId, files)).map(({ file, line }) => `${file}:${line}`).toSorted();
}
