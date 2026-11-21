import { readFileSync } from "node:fs";
import path from "node:path";

export interface Migration {
  readonly tag: string;
  readonly name: string;
  readonly sqlPath: string;
  readonly snapshot: string;
}

const nameOf = (tag: string) => tag.replace(/^\d+_/, "");

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

export function statements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})( |$)/m.test(text);
}
