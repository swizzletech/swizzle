import type { Rule } from "../lint.js";

const FROZEN = ["--frozen-lockfile", "--frozen-lockfile=true"];
/** pnpm's global options that take their value as the next word, as in `pnpm --dir db install`. */
const VALUE_OPTIONS = [
  "-C",
  "--dir",
  "-F",
  "--filter",
  "--filter-prod",
  "--loglevel",
  "--reporter",
];

/** The index of the pnpm subcommand after `pnpm` at `index`, past its global options. */
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
        // The last frozen-lockfile flag wins, as in pnpm's own argument parsing.
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
