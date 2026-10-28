import type { Rule, Violation } from "../lint.js";
import { SKILL } from "./skill-teaches-the-product.js";

const DOCKERFILE = "infra/docker/Dockerfile";
const SKILL_FILE = `${SKILL}/SKILL.md`;
const PACKAGES_LINE = "The exact packages: Debian ";

// The shipped skill tells agents what a deployed run can call. Its "Execution environment" names
// the Node major and every Debian and npm package the runner-base target installs, so a change to
// the image that leaves the skill behind fails here.
export const skillNamesTheRunnerImage: Rule = {
  id: "skill-names-the-runner-image",
  check(repo) {
    if (!repo.exists(DOCKERFILE) || !repo.exists(SKILL_FILE)) return [];
    const dockerfile = repo.read(DOCKERFILE);
    const stage = /^FROM node:(\d+)\.\S+ AS runner-base$([\s\S]*?)(?=^FROM |(?![\s\S]))/mu.exec(
      dockerfile,
    );
    if (stage === null) {
      return [
        { file: DOCKERFILE, line: 1, message: "Found no runner-base stage FROM node:<version>." },
      ];
    }
    const [, node = "", body = ""] = stage;
    // One shell command per entry: continuation lines joined, then split at && ; || and |.
    const commands = body
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
      .replaceAll(/\\\n/gu, " ")
      .split(/&&|\|\||[;|\n]/u);
    const installed = (command: RegExp) =>
      commands
        .flatMap((text) => command.exec(text)?.[1]?.trim().split(/\s+/u) ?? [])
        .filter((word) => /^[@a-z0-9]/u.test(word))
        // pnpm@12 names a version, @openai/codex names a scope.
        .map((word) => word.replace(/(?<=.)@[^@/]+$/u, ""));
    const debian = installed(/apt-get install(.*)/u);
    const npm = installed(/npm install --global(.*)/u);

    const skill = repo.read(SKILL_FILE);
    const lines = skill.split("\n");
    const index = lines.findIndex((line) => line.startsWith(PACKAGES_LINE));
    if (index === -1) {
      return [
        {
          file: SKILL_FILE,
          line: 1,
          message: `Execution environment must list the runner image's packages on a line starting "${PACKAGES_LINE}".`,
        },
      ];
    }
    const [debianText = "", npmText = ""] = (lines[index] ?? "").split("; npm ");
    const named = (text: string) =>
      [...text.matchAll(/`([^`]+)`/gu)].flatMap((match) => match[1] ?? []);
    const violations: Violation[] = [];
    const compare = (kind: string, image: readonly string[], listed: readonly string[]) => {
      const missing = image.filter((name) => !listed.includes(name));
      const extra = listed.filter((name) => !image.includes(name));
      if (missing.length > 0 || extra.length > 0)
        violations.push({
          file: SKILL_FILE,
          line: index + 1,
          message: `The skill's ${kind} packages differ from runner-base in ${DOCKERFILE}: ${[
            ...missing.map((name) => `${name} is installed but not listed`),
            ...extra.map((name) => `${name} is listed but not installed`),
          ].join(", ")}.`,
        });
    };
    compare("Debian", debian, named(debianText));
    compare("npm", npm, named(npmText));
    const claimed = /^- Node\.js (\d+)\b/mu.exec(skill);
    if (claimed?.[1] !== node)
      violations.push({
        file: SKILL_FILE,
        line: claimed === null ? 1 : skill.slice(0, claimed.index).split("\n").length,
        message: `Execution environment must say "- Node.js ${node}", the Node of runner-base.`,
      });
    return violations;
  },
};
