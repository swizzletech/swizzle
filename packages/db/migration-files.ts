// The files drizzle-kit writes under packages/db/drizzle, as check-migrations.ts and
// rebase-migrations.ts read them.

import { readFileSync } from "node:fs";
import path from "node:path";

export interface Migration {
  /** The journal tag, also the SQL file's name: `0028_run_wait_details`. */
  readonly tag: string;
  /** The tag without its number, the name `just db-generate` was given: `run_wait_details`. */
  readonly name: string;
  readonly sqlPath: string;
  readonly snapshot: string;
}

const nameOf = (tag: string) => tag.replace(/^\d+_/, "");

/** The migrations meta/_journal.json in `dir` lists, in order, with their file paths. */
export function journal(dir: string): Migration[] {
  const { entries } = JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  return entries.map(({ idx, tag }) => ({
    tag,
    name: nameOf(tag),
    sqlPath: path.join(dir, `${tag}.sql`),
    snapshot: path.join(dir, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`),
  }));
}

/** The statements of a migration's SQL, split where drizzle-kit marks breakpoints. */
export function statements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** True when git left an unresolved merge conflict in the text. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})( |$)/m.test(text);
}
