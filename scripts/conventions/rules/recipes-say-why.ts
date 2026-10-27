import type { Rule, Violation } from "../lint.js";

export const recipesSayWhy: Rule = {
  id: "recipes-say-why",
  check(repo) {
    const lines = repo.exists("justfile") ? repo.read("justfile").split("\n") : [];
    return repo
      .recipes()
      .filter((recipe) => !recipe.private)
      .flatMap(({ name, doc, line }): Violation[] => {
        if (doc === undefined) {
          return [
            {
              file: "justfile",
              line,
              message: `Recipe \`${name}\` has no doc comment. \`just\` lists each recipe with the comment above it, which is how a reader learns why it exists.`,
            },
          ];
        }
        // The doc is the nearest comment above the header; attributes may sit between them.
        const docIndex = lines.slice(0, line - 1).findLastIndex((text) => text.startsWith("#"));
        if (!lines[docIndex - 1]?.startsWith("#")) return [];
        return [
          {
            file: "justfile",
            line: docIndex + 1,
            message: `The comment above recipe \`${name}\` spans several lines, and \`just --list\` shows only the last one as its doc. Say why in one line; put a note above it after a blank line.`,
          },
        ];
      });
  },
};
