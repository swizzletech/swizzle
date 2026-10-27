import type { Rule } from "../lint.js";

const ENV_EXAMPLE = ".env.example";
const COMPOSE = "infra/docker/compose.yml";
/** `extends: { file: execution.yml, ... }`: Compose interpolates the extended file with the same env. */
const EXTENDED = /\bfile:\s*["']?([\w.-]+\.ya?ml)/gu;
/** A setting, set or commented out: `KEY=value` or `# KEY=value`. Indented examples are not settings. */
const SETTING = /^(?:# ?)?([A-Z][A-Z0-9_]*)=/u;

export const envExampleReachesCompose: Rule = {
  id: "env-example-reaches-compose",
  check(repo) {
    if (!repo.exists(ENV_EXAMPLE) || !repo.exists(COMPOSE)) return [];
    const packaged = repo.read(COMPOSE);
    const compose = [
      packaged,
      ...[...new Set([...packaged.matchAll(EXTENDED)].map((match) => match[1]))]
        .map((file) => `infra/docker/${file}`)
        .filter((file) => repo.exists(file))
        .map((file) => repo.read(file)),
    ].join("\n");
    return repo
      .read(ENV_EXAMPLE)
      .split("\n")
      .flatMap((text, index) => {
        const key = text.match(SETTING)?.[1];
        if (key === undefined) return [];
        if (compose.includes(`\${${key}:`) || compose.includes(`\${${key}}`)) return [];
        return [
          {
            file: ENV_EXAMPLE,
            line: index + 1,
            message: `${key} is a setting in .env.example, but ${COMPOSE} and the files it extends never read it, so setting it in .env changes nothing on the packaged stack. Pass it to the service that reads it.`,
          },
        ];
      });
  },
};
