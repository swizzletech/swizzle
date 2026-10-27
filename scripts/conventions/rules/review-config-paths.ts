import path from "node:path";
import { parse } from "yaml";
import type { Rule } from "../lint.js";
import type { Repo } from "../repo.js";

/** The automated pull request review's configuration. */
const REVIEW_CONFIG = ".coderabbit.yaml";

/** A file named in backticks in review instructions: it has a directory or a file extension. */
const NAMED_FILE =
  /`([\w.@*{},-]*(?:\/[\w.@*{},-]+)+|[\w.-]+\.(?:md|ts|tsx|mts|mjs|py|ya?ml|json))`/gu;

interface ReviewConfig {
  reviews?: {
    path_filters?: string[];
    path_instructions?: { path: string; instructions: string }[];
  };
  knowledge_base?: {
    code_guidelines?: { filePatterns?: (string | { files: string; applyTo: string })[] };
  };
}

/** Every glob the configuration matches files with, and every file its instructions name. */
function pointers(config: ReviewConfig): string[] {
  // A comma inside braces separates a glob's alternatives, not two globs.
  const commaSeparated = (globs: string) => globs.split(/,(?![^{]*\})/u).map((glob) => glob.trim());
  return [
    ...(config.reviews?.path_filters ?? []).map((filter) => filter.replace(/^!/u, "")),
    ...(config.reviews?.path_instructions ?? []).flatMap(({ path: glob, instructions }) => [
      glob,
      ...[...instructions.matchAll(NAMED_FILE)].map((match) => match[1] ?? ""),
    ]),
    ...(config.knowledge_base?.code_guidelines?.filePatterns ?? []).flatMap((pattern) =>
      typeof pattern === "string"
        ? commaSeparated(pattern)
        : [...commaSeparated(pattern.files), ...commaSeparated(pattern.applyTo)],
    ),
  ];
}

/** Whether `target` is a glob that matches a tracked file, or a tracked file or directory. */
function resolves(repo: Repo, target: string): boolean {
  return /[*?{[]/u.test(target)
    ? repo.files.some((file) => path.posix.matchesGlob(file, target))
    : repo.exists(target);
}

// The review reads its rules from the files the configuration points at, and it skips a pattern
// that matches nothing without saying so. A rename would quietly drop a rule from every review.
export const reviewConfigPaths: Rule = {
  id: "review-config-paths",
  check(repo) {
    if (!repo.exists(REVIEW_CONFIG)) return [];
    const text = repo.read(REVIEW_CONFIG);
    const lines = text.split("\n");
    return [...new Set(pointers(parse(text) as ReviewConfig))]
      .filter((target) => !resolves(repo, target))
      .map((target) => {
        const whole = new RegExp(
          `(?<![\\w/])${target.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}(?![\\w/])`,
          "u",
        );
        return {
          file: REVIEW_CONFIG,
          line: lines.findIndex((line) => whole.test(line)) + 1,
          message: `${target} matches no tracked file, so the review silently skips it. Point it at the current path or remove it.`,
        };
      });
  },
};
