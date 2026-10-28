import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BaseSequencer, createVitest } from "vitest/node";
import { changedFiles, resultKey, selectTests } from "./affected-tests.js";

const help = `Run the tests affected by the diff, reusing green results for identical content.
Usage: just test-affected [--base <revision>] [--shard <index/count>] [--list]
  --base   Compare with this revision's merge base (default: main).
  --shard  Run one Vitest shard, after selection.
  --list   Print selected test files without running or caching them.
Examples:
  just test-affected --base HEAD
  just test-affected --base main --shard 1/3
  just verify-fast --base HEAD`;

async function main() {
  let values: ReturnType<typeof parseOptions>;
  try {
    values = parseOptions();
  } catch (error) {
    console.log(`error: ${error instanceof Error ? error.message : String(error)}\n${help}`);
    process.exitCode = 2;
    return;
  }
  if (values.help) {
    console.log(help);
    return;
  }
  const root = process.cwd();
  let changed: string[] | undefined;
  try {
    changed = changedFiles(root, values.base ?? "main");
  } catch {
    console.log("comparison: unavailable; selecting the full suite");
  }
  const vitest = await createVitest({
    watch: false,
    run: true,
    forceRerunTriggers: [],
    ...(values.shard === undefined ? {} : { shard: values.shard }),
  });
  try {
    const selection = await selectTests(vitest, changed);
    const files = values.shard
      ? await new BaseSequencer(vitest).shard(selection.files)
      : selection.files;
    // Shard before global setup so an empty shard starts no database. The pool must not shard again.
    delete vitest.config.shard;
    delete vitest.config.related;
    console.log(
      `selected: ${files.length} of ${selection.total} test files (${selection.reason}${values.shard ? `; shard ${values.shard}` : ""})`,
    );
    if (values.list) {
      for (const file of files) console.log(path.relative(root, file.moduleId));
      return;
    }
    const key = resultKey(root, files);
    const cache = path.join(root, "node_modules/.cache/affected-tests");
    const marker = path.join(cache, `${key}.green`);
    let cached = false;
    try {
      cached = readFileSync(marker, "utf8") === "passed\n";
    } catch {
      /* Missing or unreadable cache entries run the tests. */
    }
    if (cached) {
      console.log(`cache: reused green results for ${files.length} test files`);
      return;
    }
    if (files.length > 0) {
      await vitest.standalone();
      const result = await vitest.runTestSpecifications(files, files.length === selection.total);
      if (
        result.unhandledErrors.length > 0 ||
        result.testModules.some((file) => file.state() === "failed") ||
        process.exitCode
      ) {
        process.exitCode = 1;
        return;
      }
    }
    await vitest.close();
    if (process.exitCode) return;
    if (resultKey(root, files) !== key) {
      console.log("cache: inputs changed during the run; results were not saved");
      return;
    }
    mkdirSync(cache, { recursive: true });
    const temporary = `${marker}.${randomUUID()}.tmp`;
    writeFileSync(temporary, "passed\n");
    renameSync(temporary, marker);
    console.log(`cache: saved green results for ${files.length} test files`);
  } finally {
    await vitest.close();
  }
}

function parseOptions() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      shard: { type: "string" },
      list: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.shard !== undefined) {
    const match = /^(\d+)\/(\d+)$/u.exec(values.shard);
    if (
      !match ||
      Number(match[1]) < 1 ||
      Number(match[1]) > Number(match[2]) ||
      !Number.isSafeInteger(Number(match[2]))
    ) {
      throw new Error("--shard must be index/count with 1 <= index <= count");
    }
  }
  return values;
}

await main();
