import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { TestSpecification, Vitest } from "vitest/node";

export type Selection = {
  reason: string;
  files: TestSpecification[];
  total: number;
};

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function changedFiles(root: string, base: string): string[] {
  const ancestor = git(root, ["merge-base", base, "HEAD"]).trim();
  return [
    ...new Set([
      ...git(root, ["diff", "--name-only", "--no-renames", "-z", ancestor]).split("\0"),
      ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ]),
  ]
    .filter(Boolean)
    .sort();
}

function isDocumentation(file: string): boolean {
  return file === "README.md" || /^docs\/.*\.md$/u.test(file);
}

export async function selectTests(
  vitest: Vitest,
  changed: string[] | undefined,
): Promise<Selection> {
  const all = await vitest.globTestSpecifications();
  const declared = fileInputs(vitest.config.root);
  const name = (file: TestSpecification) =>
    path.relative(vitest.config.root, file.moduleId).split(path.sep).join("/");
  const testNames = new Set(all.map(name));
  for (const test of declared.keys()) {
    if (!test.startsWith("**/") && !testNames.has(test))
      throw new Error(`test/inputs.json names an unknown test: ${test}`);
  }
  const force = changed?.find(
    (file) =>
      !existsSync(path.resolve(vitest.config.root, file)) ||
      (!isDocumentation(file) &&
        ((!file.includes("/") && !/\.(test|spec)\.[cm]?[jt]sx?$/u.test(file)) ||
          /(^|\/)(test|tests|test-fixtures)\//u.test(file) ||
          /(^|\/)(package\.json|tsconfig[^/]*\.json)$/u.test(file) ||
          /^(vitest\.config\.|scripts\/(affected-tests|test-run-reporter|test-sequencer))/u.test(
            file,
          ) ||
          !/\.[cm]?[jt]sx?$|\.snap$/u.test(file))),
  );
  if (changed === undefined || changed.length === 0 || force !== undefined) {
    return {
      reason:
        force === undefined
          ? `full suite (${changed === undefined ? "comparison unavailable" : "no changes"})`
          : `shared or non-module input: ${force}`,
      files: all,
      total: all.length,
    };
  }
  const selected = new Set<string>();
  const identity = (file: TestSpecification) =>
    `${file.project.name}\0${file.moduleId}\0${file.pool}`;
  for (const changedFile of changed) {
    // Use docs-check's prose test so an accompanying guide does not select the whole suite.
    const input = isDocumentation(changedFile)
      ? "scripts/agent-reference-drift.test.ts"
      : changedFile;
    vitest.config.related = [path.resolve(vitest.config.root, input)];
    const consumers = await vitest.getRelevantTestSpecifications();
    const external = all.filter((file) =>
      [...declared].some(
        ([test, patterns]) =>
          path.matchesGlob(name(file), test) &&
          patterns.some((pattern) => path.matchesGlob(changedFile, pattern)),
      ),
    );
    // An undeclared input with no import edge still fails safe by running every test.
    if (consumers.length === 0 && external.length === 0) {
      return { reason: `unmapped input: ${changedFile}`, files: all, total: all.length };
    }
    for (const file of [...consumers, ...external]) selected.add(identity(file));
  }
  return {
    reason: changed.some(isDocumentation)
      ? `imports and documentation for ${changed.length} changed files`
      : `imports of ${changed.length} changed files`,
    files: all.filter((file) => selected.has(identity(file))),
    total: all.length,
  };
}

export function resultKey(root: string, files: TestSpecification[]): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      runtime: [process.version, process.platform, process.arch],
      environment: Object.entries(process.env)
        .filter(([name]) =>
          /^(SWIZZLE_|DATABASE_URL$|VALKEY_URL$|DOCKER_|NODE_|CI$|TZ$|LANG$|LC_|PATH$|PYTHON)/u.test(
            name,
          ),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
      files: files.map((file) => [file.project.name, path.relative(root, file.moduleId)]).sort(),
    }),
  );
  const inputs = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  for (const file of [...new Set(inputs.split("\0").filter(Boolean))].sort()) {
    const absolute = path.join(root, file);
    hash.update(
      JSON.stringify([
        file,
        existsSync(absolute)
          ? [
              lstatSync(absolute).mode & 0o111,
              lstatSync(absolute).isSymbolicLink()
                ? readlinkSync(absolute)
                : createHash("sha256").update(readFileSync(absolute)).digest("hex"),
            ]
          : null,
      ]),
    );
  }
  return hash.digest("hex");
}

function fileInputs(root: string): Map<string, readonly string[]> {
  const value: unknown = JSON.parse(readFileSync(path.join(root, "test/inputs.json"), "utf8"));
  const invalid = () =>
    new Error("test/inputs.json must map test paths to arrays of source patterns");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const inputs = new Map<string, readonly string[]>();
  for (const [test, patterns] of Object.entries(value)) {
    if (
      !Array.isArray(patterns) ||
      !patterns.every((pattern: unknown) => typeof pattern === "string")
    )
      throw invalid();
    inputs.set(test, patterns);
  }
  return inputs;
}
