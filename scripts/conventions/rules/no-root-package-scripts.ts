import type { Rule } from "../lint.js";

export const noRootPackageScripts: Rule = {
  id: "no-root-package-scripts",
  check(repo) {
    if (!repo.exists("package.json")) return [];
    const text = repo.read("package.json");
    if (!("scripts" in (JSON.parse(text) as object))) return [];
    return [
      {
        file: "package.json",
        line: text.split("\n").findIndex((line) => line.includes('"scripts"')) + 1,
        message:
          "The justfile is the only way to run anything. Root package scripts would be a second one; add a recipe instead.",
      },
    ];
  },
};
