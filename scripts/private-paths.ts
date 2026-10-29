// The paths the public export leaves out: `just export-public` excludes them from the archive, and
// the no-private-paths convention refuses a public file that names one of them.

/** Names left out wherever they appear, with everything under them. */
const ANYWHERE = ["AGENTS.md", "CLAUDE.md", ".agents"];
/** Root paths left out with everything under them. */
const AT_ROOT = ["CONTEXT.md", "docs/adr", ".out-of-scope"];

/** `git archive` pathspecs that leave the private paths out. */
export const PRIVATE_PATHSPECS: readonly string[] = [
  ...ANYWHERE.flatMap((name) => [`:(exclude,glob)**/${name}`, `:(exclude,glob)**/${name}/**`]),
  ...AT_ROOT.map((root) => `:(exclude)${root}`),
];

/** Whether the export leaves out `file`, a repo-relative POSIX path. */
export function isPrivate(file: string): boolean {
  return (
    file.split("/").some((part) => ANYWHERE.includes(part)) ||
    AT_ROOT.some((root) => file === root || file.startsWith(`${root}/`))
  );
}

/** Configurations whose private path entries leave with the files they refer to. */
export const PUBLIC_CONFIG_FILES: readonly string[] = [
  "knip.jsonc",
  "test/inputs.json",
  "tsconfig.test.json",
];

/** The public contents inspected by conventions and written by the exporter. */
export function exportConfiguration(file: string, text: string): string {
  if (!PUBLIC_CONFIG_FILES.includes(file)) return text;
  // These configurations use whole-line comments. Malformed input fails before anything is exported.
  const value: unknown = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  return `${JSON.stringify(publicConfiguration(value), null, 2)}\n`;
}

/** Remove private path keys and array entries from exported configuration. */
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
