import path from "node:path";
import { isNode, LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import type { Rule } from "../lint.js";
import type { Repo } from "../repo.js";

const REVIEW_CONFIG = ".coderabbit.yaml";

const NAMED_FILE =
  /`([\w.@*{},-]*(?:\/[\w.@*{},-]+)+|[\w.-]+\.(?:md|ts|tsx|mts|mjs|py|ya?ml|json))`/gu;

const reviewConfig = z.object({
  reviews: z
    .object({
      path_filters: z.array(z.string()).optional(),
      path_instructions: z
        .array(z.object({ path: z.string(), instructions: z.string() }))
        .optional(),
    })
    .optional(),
  knowledge_base: z
    .object({
      code_guidelines: z
        .object({
          filePatterns: z
            .array(z.union([z.string(), z.object({ files: z.string(), applyTo: z.string() })]))
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

function commaSeparated(globs: string): string[] {
  let start = 0;
  let braces = 0;
  let characterClass = false;
  const patterns: string[] = [];
  for (const match of globs.matchAll(/\\.|[{},[\]]/gu)) {
    switch (match[0]) {
      case "[":
        characterClass = true;
        break;
      case "]":
        characterClass = false;
        break;
      case "{":
        if (!characterClass) braces += 1;
        break;
      case "}":
        if (!characterClass && braces > 0) braces -= 1;
        break;
      case ",":
        if (!characterClass && braces === 0) {
          patterns.push(globs.slice(start, match.index).trim());
          start = match.index + 1;
        }
        break;
    }
  }
  return [...patterns, globs.slice(start).trim()];
}

function pointers(config: z.infer<typeof reviewConfig>): string[] {
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

function resolves(repo: Repo, target: string): boolean {
  return /[*?{[]/u.test(target)
    ? repo.files.some((file) => path.posix.matchesGlob(file, target))
    : repo.exists(target);
}

export const reviewConfigPaths: Rule = {
  id: "review-config-paths",
  check(repo) {
    if (!repo.exists(REVIEW_CONFIG)) return [];
    const text = repo.read(REVIEW_CONFIG);
    const lines = text.split("\n");
    const counter = new LineCounter();
    const document = parseDocument(text, { lineCounter: counter });
    if (document.errors.length > 0) {
      return document.errors.map((error) => ({
        file: REVIEW_CONFIG,
        line: counter.linePos(error.pos[0]).line,
        message: `Invalid YAML: ${error.message}`,
      }));
    }
    const result = reviewConfig.safeParse(document.toJSON());
    if (!result.success) {
      return result.error.issues.map(({ path, message }) => {
        const node = document.getIn(path, true);
        const parent = document.getIn(path.slice(0, -1), true);
        const offset =
          (isNode(node) ? node.range?.[0] : undefined) ??
          (isNode(parent) ? parent.range?.[0] : undefined) ??
          0;
        return {
          file: REVIEW_CONFIG,
          line: counter.linePos(offset).line,
          message: `Invalid review configuration at ${path.join(".") || "document"}: ${message}`,
        };
      });
    }
    return [...new Set(pointers(result.data))]
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
