import type { Rule, Violation } from "../lint.js";

// mise runs the recipes; Docker, pnpm and the run image fallback read their own copies of these pins.
export const toolchainPins: Rule = {
  id: "toolchain-pins",
  check(repo) {
    if (!repo.exists("mise.toml")) return [];
    const pins = repo.read("mise.toml");
    const checks = [
      { tool: "node", file: "infra/docker/Dockerfile", pattern: /^ARG NODE_VERSION=([\d.]+)-/mu },
      {
        tool: "node",
        file: "infra/docker/Dockerfile",
        pattern: /^FROM node:([\d.]+)-\S+ AS runner-base$/mu,
      },
      {
        tool: "node",
        file: "packages/runtime/src/run-image.ts",
        pattern: /^const NODE_BASE_IMAGE = "node:([\d.]+)-\S+";$/mu,
      },
      { tool: "pnpm", file: "package.json", pattern: /"packageManager": "pnpm@([^"]+)"/u },
      {
        tool: "pnpm",
        file: "infra/docker/Dockerfile",
        pattern: /npm install --global --no-audit --no-fund pnpm@(\S+)$/mu,
      },
    ];
    return checks.flatMap(({ tool, file, pattern }): Violation[] => {
      const pin = pins.match(new RegExp(`^${tool} = "([^"]+)"$`, "mu"))?.[1];
      const text = repo.exists(file) ? repo.read(file) : "";
      const match = pattern.exec(text);
      if (pin !== undefined && match?.[1] === pin) return [];
      return [
        {
          file,
          line: match === null ? 1 : text.slice(0, match.index).split("\n").length,
          message: `${tool} must match mise.toml (${pin ?? "missing pin"}); found ${match?.[1] ?? "no pin"}. Recipes, pnpm and images must use the same toolchain.`,
        },
      ];
    });
  },
};
