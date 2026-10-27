import type { Rule } from "../lint.js";

const PACKAGE_VERSION = /"version"\s*:\s*"([^"]+)"/u;

/** The CLI, API and default image tag must describe the same release. */
export const platformVersion: Rule = {
  id: "platform-version",
  check(repo) {
    if (!repo.exists("package.json")) return [];
    const version = repo.read("package.json").match(PACKAGE_VERSION)?.[1];
    const copies = [
      ...repo.files
        .filter((file) => /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(file))
        .map((file) => ({ file, pattern: PACKAGE_VERSION })),
      {
        file: "packages/core/src/version.ts",
        pattern: /export const APP_VERSION = "([^"]+)";/u,
      },
      { file: ".env.example", pattern: /^SWIZZLE_IMAGE_TAG=v(\S+)$/mu },
    ];
    return copies.flatMap(({ file, pattern }) => {
      const text = repo.exists(file) ? repo.read(file) : "";
      const match = pattern.exec(text);
      if (version !== undefined && match?.[1] === version) return [];
      return [
        {
          file,
          line: match === null ? 1 : text.slice(0, match.index).split("\n").length,
          message: `Version must match package.json (${version ?? "missing version"}); found ${match?.[1] ?? "no version"}. Update every workspace package.json, packages/core/src/version.ts and .env.example together.`,
        },
      ];
    });
  },
};
