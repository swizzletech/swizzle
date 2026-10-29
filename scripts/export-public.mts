// `just export-public <directory> [commit]` writes an independent public checkout, without history.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { exportConfiguration, PRIVATE_PATHSPECS, PUBLIC_CONFIG_FILES } from "./private-paths.ts";

/** Resolve a formatter that matches the selected commit's lockfile. */
async function selectedFormatter(directory: string): Promise<string> {
  const documents = parseAllDocuments(
    await readFile(path.join(directory, "pnpm-lock.yaml"), "utf8"),
  );
  const versions = documents.flatMap((document) => {
    if (document.errors.length) throw new Error("Selected commit has an invalid pnpm-lock.yaml");
    const version = document.getIn([
      "importers",
      ".",
      "devDependencies",
      "@biomejs/biome",
      "version",
    ]);
    return typeof version === "string" ? [version] : [];
  });
  const [version] = versions;
  if (!version || versions.length !== 1)
    throw new Error("Selected commit must lock exactly one root Biome version");
  const formatter = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
  const installed = execFileSync(formatter, ["--version"], { encoding: "utf8" }).trim();
  if (installed !== `Version: ${version}`)
    throw new Error(
      `Selected commit requires Biome ${version}; found ${installed}. Run just deps at the selected commit before exporting.`,
    );
  return formatter;
}

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
    const formatter = await selectedFormatter(output);
    for (const file of PUBLIC_CONFIG_FILES) {
      const target = path.join(output, file);
      let text: string;
      try {
        text = await readFile(target, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      const formatted = execFileSync(
        formatter,
        ["format", "--stdin-file-path", file, "--config-path", path.join(output, "biome.jsonc")],
        {
          input: exportConfiguration(file, text),
          encoding: "utf8",
          cwd: output,
        },
      );
      await writeFile(target, formatted);
    }
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
    "Usage: just export-public <directory> [commit]\n\nInstall dependencies with just deps at the selected commit before exporting.\nFormatting uses its archived Biome configuration and locked version.\nExports HEAD by default to a new directory. Its parent must exist.\nStages public files in a fresh Git repository; creates no commit or tag.\n\nExamples:\n  just export-public ../swizzle-1.0.0\n  just export-public ../swizzle-rc v1.0.0-rc.1",
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
