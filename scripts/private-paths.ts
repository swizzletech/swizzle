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
