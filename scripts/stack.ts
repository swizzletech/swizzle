// `just stack` and the backup recipes share release selection and image preparation.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { capture, preflight, prepareImages, run } from "./stack-images.ts";

try {
  const [command, ...args] = process.argv.slice(2);
  if (
    !["up", "prepare"].includes(command ?? "") ||
    (command === "up" && args.length > 0) ||
    (command === "prepare" && args.length === 0)
  ) {
    throw new Error("Usage: node scripts/stack.ts up | prepare <compose-file> [service ...]");
  }
  const source = { root: process.cwd(), envFile: path.resolve(".env") };
  preflight(source);
  const state = capture("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "swizzle-stack",
  ]);
  if (command === "prepare") {
    const [output, ...services] = args;
    if (output === undefined) throw new Error("Pass the prepared Compose file path.");
    prepareImages(source, path.resolve(output), services.length > 0 ? { services } : {});
  } else {
    // The Git directory survives checkout changes and keeps resolved credentials out of the tree.
    const directory = mkdtempSync(`${state}-`);
    try {
      const prepared = prepareImages(source, path.join(directory, "compose.json"), {
        tag: "local",
      });
      run("docker", [
        "compose",
        "-f",
        prepared.file,
        "--profile",
        "stack",
        "up",
        "--no-build",
        "--pull",
        "never",
        "-d",
        "--wait",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} catch (error) {
  process.stderr.write(
    `Stack stopped: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
