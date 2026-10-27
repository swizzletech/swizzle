import type { Rule } from "../lint.js";
import { SKILL } from "./skill-teaches-the-product.js";

const DIRECT_TOOLS = new Set([
  "biome",
  "depcruise",
  "drizzle-kit",
  "gitleaks",
  "knip",
  "lefthook",
  "npm",
  "npx",
  "playwright",
  "pnpm",
  "tsx",
  "turbo",
  "vitest",
  "yarn",
]);

/** Authors install the published CLI without a checkout, so this is the one way to install it. */
const CLI_INSTALL = "npm install --global @swizzletech/cli";

export const docsRunJustRecipes: Rule = {
  id: "docs-run-just-recipes",
  check(repo) {
    const recipes = new Set(repo.recipes().map((recipe) => recipe.name));
    return repo
      .commands()
      .filter(({ file, source }) => source.startsWith("markdown") && !file.startsWith(`${SKILL}/`))
      .flatMap(({ file, line, words, source }) => {
        const [command = "", next] = words;
        const code = words.join(" ");
        // A lone `tsx` in prose names the tool; a span with arguments or a block line runs it.
        if (
          DIRECT_TOOLS.has(command) &&
          code !== CLI_INSTALL &&
          !(source === "markdown-span" && next === undefined)
        ) {
          return [
            {
              file,
              line,
              message: `\`${code}\` runs ${command} directly. Docs name the just recipe, so each task has one way to run it; \`just\` lists them.`,
            },
          ];
        }
        if (
          command === "just" &&
          next !== undefined &&
          /^[a-z]/u.test(next) &&
          !recipes.has(next)
        ) {
          return [{ file, line, message: `\`${code}\` names no recipe in the justfile.` }];
        }
        return [];
      });
  },
};
