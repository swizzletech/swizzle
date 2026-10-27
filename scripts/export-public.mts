// `just export-public <directory> [commit]` writes an independent public checkout, without history.
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { PRIVATE_PATHSPECS } from "./private-paths.ts";

/** Export a commit's public tree to a new directory; return the resolved source commit. */
async function exportPublic(destination: string, commit: string): Promise<string> {
  const source = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`],
    {
      encoding: "utf8",
    },
  ).trim();
  const output = path.resolve(destination);
  // mkdir without recursive refuses existing files, directories and symlinks. Never overwrite a checkout.
  await mkdir(output);
  try {
    const archive = execFileSync(
      "git",
      ["archive", "--format=tar", source, "--", ".", ...PRIVATE_PATHSPECS],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    execFileSync("tar", ["-xf", "-", "-C", output], { input: archive });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", output]);
    // The conventions inspect tracked files. Stage the archive, without creating a public commit or tag.
    execFileSync("git", ["-C", output, "add", "--all"]);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return source;
}

const args = process.argv.slice(2);
if (args[0] === "--help") {
  console.log(
    "Usage: just export-public <directory> [commit]\n\nExports HEAD by default to a new directory. Its parent must exist.\nStages public files in a fresh Git repository; creates no commit or tag.\n\nExamples:\n  just export-public ../swizzle-1.0.0\n  just export-public ../swizzle-rc v1.0.0-rc.1",
  );
} else {
  const [destination, commit = "HEAD"] = args;
  if (!destination || args.length > 2) {
    console.error("Usage: just export-public <directory> [commit]. Use --help for examples.");
    process.exitCode = 2;
  } else {
    try {
      const source = await exportPublic(destination, commit);
      console.log(`Exported ${source} to ${path.resolve(destination)}. Ready for just verify.`);
    } catch (error) {
      console.error(`export-public: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
