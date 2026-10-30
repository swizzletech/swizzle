#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (
  args[0] === "buildx" &&
  args[args.indexOf("--file") + 1].endsWith("Dockerfile.runner") &&
  args[args.indexOf("--target") + 1] === process.env.INTERLEAVE_TARGET
) {
  execFileSync(
    process.execPath,
    [
      process.env.INTERLEAVE_PREPARE,
      process.env.INTERLEAVE_ROOT,
      process.env.INTERLEAVE_OUTPUT,
      process.env.INTERLEAVE_TAG,
    ],
    {
      env: { ...process.env, PATH: process.env.INTERLEAVE_PATH },
      stdio: "inherit",
    },
  );
}
if (process.env.INTERLEAVE_CLEANUP_CALLS && args[0] === "image" && args[1] === "rm") {
  appendFileSync(process.env.INTERLEAVE_CLEANUP_CALLS, `${args[2]}\n`);
  // Delete the first reference before forwarding cleanup, so Docker returns a real missing-tag error.
  if (args[2].includes("-runner-base:")) {
    execFileSync(process.env.INTERLEAVE_DOCKER, args, { stdio: "inherit" });
  }
}
const result = spawnSync(process.env.INTERLEAVE_DOCKER, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
