const ANYWHERE = ["AGENTS.md", "CLAUDE.md", ".agents"];
const AT_ROOT = ["CONTEXT.md", "docs/adr", ".out-of-scope"];

export const PRIVATE_PATHSPECS: readonly string[] = [
  ...ANYWHERE.flatMap((name) => [`:(exclude,glob)**/${name}`, `:(exclude,glob)**/${name}/**`]),
  ...AT_ROOT.map((root) => `:(exclude)${root}`),
];

export function isPrivate(file: string): boolean {
  return (
    file.split("/").some((part) => ANYWHERE.includes(part)) ||
    AT_ROOT.some((root) => file === root || file.startsWith(`${root}/`))
  );
}

export const PUBLIC_CONFIG_FILES: readonly string[] = [
  "knip.jsonc",
  "scripts/conventions/comment-budget.json",
  "test/inputs.json",
  "tsconfig.test.json",
];

export function exportConfiguration(file: string, text: string): string {
  if (!PUBLIC_CONFIG_FILES.includes(file)) return text;
  const value: unknown = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  return `${JSON.stringify(publicConfiguration(value), null, 2)}\n`;
}

function publicConfiguration(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .filter((item: unknown) => typeof item !== "string" || !isPrivate(item))
      .map(publicConfiguration);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isPrivate(key))
        .map(([key, item]) => [key, publicConfiguration(item)]),
    );
  return value;
}
