import type { Rule } from "../lint.js";

export const SKILL = "apps/cli/assets/skills/swizzle-builder";

// Prose claims the skill must not make. The commands and flags it teaches are checked against
// the CLI itself by scripts/agent-reference-drift.test.ts.
const SKILL_FORBIDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Dockerfile\.service/u, "the worker image builds from infra/docker/Dockerfile"],
  [
    /\.swizzle\/automation-home|because the host's home is mounted|defaults to \$HOME|Worker mounts host home/u,
    "the worker receives no operator home directory",
  ],
  [/localhost (?:requests )?bypasses auth/iu, "localhost is not an auth bypass"],
  [
    /- ~\/|paths \(typically under `~\/`\)/u,
    "writable_dirs cannot mount the sandbox home; use ./work or /tmp/tool-cache",
  ],
  [
    /auto-derived from name if omitted|If `path` is omitted, one is derived from `name`/u,
    "webhook deployment requires trigger.path (TRIGGER_CONFIGURATION_INVALID)",
  ],
];
export const SKILL_REQUIRES = [
  "swizzle apply my-automation --local-only",
  "receives no operator home directory",
  "localhost is not an auth bypass",
];

export const skillTeachesTheProduct: Rule = {
  id: "skill-teaches-the-product",
  check(repo) {
    const files = repo.files.filter((file) => file.startsWith(`${SKILL}/`) && file.endsWith(".md"));
    if (files.length === 0) return [];
    const forbidden = files.flatMap((file) =>
      repo
        .read(file)
        .split("\n")
        .flatMap((text, index) =>
          SKILL_FORBIDS.filter(([pattern]) => pattern.test(text)).map(([, truth]) => ({
            file,
            line: index + 1,
            message: `The shipped skill teaches agents in user workspaces, and this line is wrong: ${truth}.`,
          })),
        ),
    );
    const all = files.map((file) => repo.read(file)).join("\n");
    const missing = SKILL_REQUIRES.filter((phrase) => !all.includes(phrase)).map((phrase) => ({
      file: `${SKILL}/SKILL.md`,
      line: 1,
      message: `The shipped skill no longer says "${phrase}". That sentence corrects a mistake agents made; keep it in SKILL.md or references/.`,
    }));
    return [...forbidden, ...missing];
  },
};
