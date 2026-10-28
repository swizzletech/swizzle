import type { Rule } from "../lint.js";

export const ciRunsJustRecipes: Rule = {
  id: "ci-runs-just-recipes",
  check(repo) {
    return repo
      .commands()
      .filter(({ source, words }) => source === "workflow" && words[0] !== "just")
      .map(({ file, line, words }) => ({
        file,
        line,
        message: `CI runs \`${words.join(" ")}\` instead of a just recipe. CI uses the same recipes as local checks so their behavior stays in one place.`,
      }));
  },
};
