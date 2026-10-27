// Repository conventions that no other tool owns: `just check` and `just docs-check` run this file.
// Each rule is one file under rules/, listed in rules.ts and proven by conventions.test.ts.
// Escape hatch: `conventions-allow <rule-id>: <reason>` on the offending line or the line above it.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "./lint.js";
import { gitRepo } from "./repo.js";
import { rules } from "./rules.js";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const findings = lint(gitRepo(root), rules);
if (findings.length === 0) {
  console.log(`conventions: ${rules.length} rules green`);
} else {
  console.error(`conventions: ${findings.length} violation${findings.length === 1 ? "" : "s"}`);
  for (const { file, line, rule, message } of findings)
    console.error(`${file}:${line} ${rule}: ${message}`);
  console.error(
    "Fix each one, or put `conventions-allow <rule>: <reason>` on the line or the line above it.",
  );
  process.exitCode = 1;
}
