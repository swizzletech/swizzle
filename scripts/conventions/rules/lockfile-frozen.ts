import type { Rule } from "../lint.js";

const FROZEN = ["--frozen-lockfile", "--frozen-lockfile=true"];
const VALUE_OPTIONS = [
  "-C",
  "--dir",
  "-F",
  "--filter",
  "--filter-prod",
  "--loglevel",
  "--reporter",
];

function subcommandAt(words: readonly string[], index: number): number {
  let at = index + 1;
  while (words[at]?.startsWith("-")) at += VALUE_OPTIONS.includes(words[at] ?? "") ? 2 : 1;
  return at;
}

export const lockfileFrozen: Rule = {
  id: "lockfile-frozen",
  check(repo) {
    return repo
      .commands()
      .filter(({ source, words }) => {
        if (source.startsWith("markdown")) return false;
        const pnpm = words.findIndex(
          (word, index) =>
            word === "pnpm" && ["install", "i"].includes(words[subcommandAt(words, index)] ?? ""),
        );
        if (pnpm === -1) return false;
        const flag = words
          .slice(pnpm + 1)
          .filter((word) => /^--(no-)?frozen-lockfile(=|$)/u.test(word))
          .at(-1);
        return !FROZEN.includes(flag ?? "");
      })
      .map(({ file, line }) => ({
        file,
        line,
        message:
          "pnpm install without --frozen-lockfile may rewrite pnpm-lock.yaml, so this machine would test other dependencies than the lockfile pins.",
      }));
  },
};
