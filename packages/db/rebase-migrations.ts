// `just db-migration-rebase`: renumbers a replayed commit's migrations after the ones main landed.
// Two branches that each add a migration both take the next number, so `git rebase main` stops in
// meta/_journal.json and the snapshot. Run at that stop, this keeps HEAD's migrations (main's plus
// the commits already replayed) and regenerates the migrations the stopped commit (REBASE_HEAD)
// adds after them, each under its old name. The stopped commit is the source: its SQL and
// snapshots are what the branch wrote, whatever the conflicted working tree holds. It writes into
// a copy first and changes packages/db/drizzle only when every migration regenerated cleanly.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { generateDrizzleJson } from "drizzle-kit/api";
import config from "./drizzle.config.ts";
import { journal, statements } from "./migration-files.ts";
import * as schema from "./src/schema.ts";

/** A migration the stopped commit adds, as the branch wrote it. */
interface Added {
  readonly tag: string;
  readonly name: string;
  readonly sql: string;
  /** Written with `--custom`: its snapshot equals the one before it, so all its SQL is by hand. */
  readonly custom: boolean;
}

/** One line of the report: the old tag, the new one or none when it was dropped, and why. */
interface Renumbered {
  readonly from: string;
  readonly to: string | undefined;
  readonly note: string;
}

const db = fileURLToPath(new URL(".", import.meta.url));
const migrations = path.join(db, config.out ?? "drizzle");
const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: db,
  encoding: "utf8",
}).trim();
const tracked = path.relative(repository, migrations);
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const breakpoint = "--> statement-breakpoint\n";
const withoutIds = (snapshot: { id: string; prevId: string }) => {
  const { id: _id, prevId: _prevId, ...rest } = snapshot;
  return rest;
};

/** Why the recipe left packages/db/drizzle as it was, one indented line per reason. */
class Refusal extends Error {}
const refuse = (lines: readonly string[]): never => {
  throw new Refusal(lines.join("\n"));
};

/** A rebase is in progress; REBASE_HEAD alone outlives it, so ask for the rebase's own state. */
function rebaseStopped(): boolean {
  return ["rebase-merge", "rebase-apply"].some((state) =>
    existsSync(path.resolve(repository, git("rev-parse", "--git-path", state))),
  );
}

/** Conflicted paths outside packages/db/drizzle, which the schema may still depend on. */
function unmergedElsewhere(): string[] {
  return git("diff", "--name-only", "--diff-filter=U")
    .split("\n")
    .filter((file) => file !== "" && !file.startsWith(`${tracked}/`));
}

/** packages/db/drizzle as `ref` holds it, extracted under `into`. */
function extract(ref: string, into: string): string {
  const target = path.join(into, ref.replace(/\W/g, "_"));
  const archive = `${target}.tar`;
  git("archive", `--output=${archive}`, `--prefix=${path.basename(target)}/`, ref, "--", tracked);
  execFileSync("tar", ["-xf", archive, "-C", into]);
  return path.join(target, tracked);
}

/** The migrations `commit` lists that `parent` does not, in journal order. */
function added(commit: string, parent: string): Added[] {
  const before = new Set(journal(parent).map(({ tag }) => tag));
  const listed = journal(commit);
  return listed.flatMap((migration, index) => {
    const previous = listed[index - 1];
    if (before.has(migration.tag)) return [];
    return [
      {
        tag: migration.tag,
        name: migration.name,
        sql: readFileSync(migration.sqlPath, "utf8"),
        custom:
          previous !== undefined &&
          isDeepStrictEqual(
            withoutIds(JSON.parse(readFileSync(migration.snapshot, "utf8"))),
            withoutIds(JSON.parse(readFileSync(previous.snapshot, "utf8"))),
          ),
      },
    ];
  });
}

/**
 * Runs `drizzle-kit generate` from the working schema.ts into `out` and returns the tag it wrote,
 * or undefined when the current schema equals the last snapshot. The generator inherits the
 * terminal for rename choices. Its exit code alone is not proof that it wrote a migration.
 */
function generate(name: string, out: string, custom: true): string;
function generate(name: string, out: string, custom: false): string | undefined;
function generate(name: string, out: string, custom: boolean): string | undefined {
  const previous = journal(out).at(-1);
  if (
    !custom &&
    previous !== undefined &&
    isDeepStrictEqual(
      withoutIds(JSON.parse(readFileSync(previous.snapshot, "utf8"))),
      withoutIds(JSON.parse(JSON.stringify(generateDrizzleJson(schema)))),
    )
  )
    return undefined;
  const before = new Set(readdirSync(out));
  // drizzle-kit reads `--out` relative to its working directory, even when it is absolute.
  execFileSync(
    "pnpm",
    ["exec", "drizzle-kit", "generate", "--dialect", config.dialect]
      .concat(["--schema", String(config.schema), "--out", path.relative(db, out), "--name", name])
      .concat(custom ? ["--custom"] : []),
    { cwd: db, encoding: "utf8", maxBuffer: 2 ** 28, stdio: "inherit" },
  );
  const written = readdirSync(out).find((file) => file.endsWith(".sql") && !before.has(file));
  if (written !== undefined) return path.basename(written, ".sql");
  throw new Error(`drizzle-kit generate --name ${name} wrote no migration; its error is above.`);
}

const listing = (lines: readonly string[]) => lines.map((line) => `    ${line}`);

/**
 * Generates `migration` into `out` from the working schema.ts. A custom migration keeps its SQL.
 * A generated one keeps its old text, minus statements drizzle-kit no longer renders because a
 * migration in HEAD already runs them; the rest it does not render are by hand and stay. When
 * HEAD already makes its whole schema change, it is dropped, or becomes a custom migration of its
 * hand-written statements. Returns a problem instead when an earlier migration of this commit
 * absorbed its change, or when hand-written statements meet SQL drizzle-kit now renders anew.
 */
function regenerate(
  migration: Added,
  out: string,
  landed: ReadonlySet<string>,
  earlier: readonly string[],
): Renumbered | string {
  const { tag: from, name } = migration;
  if (migration.custom) {
    const to = generate(name, out, true);
    writeFileSync(path.join(out, `${to}.sql`), migration.sql);
    return { from, to, note: "hand-written, SQL kept" };
  }

  const original = statements(migration.sql);
  const tag = generate(name, out, false);
  const rendered =
    tag === undefined ? [] : statements(readFileSync(path.join(out, `${tag}.sql`), "utf8"));
  const absorbed = original.filter((statement) => earlier.includes(statement));
  if (tag === undefined && absorbed.length > 0) {
    return [
      `${from}: an earlier migration of this commit now carries its schema change:`,
      ...listing(absorbed),
      "  drizzle-kit renders only the sum of one commit's migrations. Split them into one commit each,",
      "  or regenerate them by hand with `just db-generate`.",
    ].join("\n");
  }
  const applied = original.filter(
    (statement) => !rendered.includes(statement) && landed.has(statement),
  );
  const kept = original.filter((statement) => !applied.includes(statement));
  const byHand = kept.filter((statement) => !rendered.includes(statement));
  const ordered = rendered.every((statement) => kept.includes(statement));
  if (!ordered && byHand.length > 0) {
    return [
      `${from} renders differently on top of HEAD, and these statements are not drizzle-kit's:`,
      ...listing(byHand),
      `  Regenerate it by hand: \`just db-generate ${name}\` on HEAD's packages/db/drizzle, then add`,
      "  the statements that still apply.",
    ].join("\n");
  }
  if (tag === undefined) {
    if (kept.length === 0) {
      return { from, to: undefined, note: "dropped, HEAD's migrations already make its change" };
    }
    const to = generate(name, out, true);
    writeFileSync(path.join(out, `${to}.sql`), kept.join(breakpoint));
    return {
      from,
      to,
      note: `HEAD's migrations already make its schema change; kept ${kept.length} hand-written statement(s)`,
    };
  }
  if (ordered) {
    const sql = applied.length === 0 ? migration.sql : kept.join(breakpoint);
    writeFileSync(path.join(out, `${tag}.sql`), sql);
  }
  const notes = [
    applied.length > 0
      ? `dropped ${applied.length} statement(s) HEAD's migrations already run`
      : "",
    byHand.length > 0 ? `kept ${byHand.length} hand-written statement(s)` : "",
    ordered ? "" : "SQL regenerated, HEAD changed what it must do",
  ].filter(Boolean);
  return { from, to: tag, note: notes.length > 0 ? notes.join("; ") : "SQL unchanged" };
}

/** Replaces packages/db/drizzle with `out` and stages it, which resolves its conflicts. */
function replace(out: string): void {
  rmSync(migrations, { recursive: true, force: true });
  cpSync(out, migrations, { recursive: true });
  git("add", "--all", "--", tracked);
}

/** Renumbers the stopped commit's migrations and returns the report; throws a Refusal instead of a half-done job. */
function rebase(): string[] {
  if (!rebaseStopped()) {
    refuse([
      "  No rebase is stopped. Run `git rebase main` and, where it stops on",
      `  ${tracked}/meta/_journal.json, run this recipe. If a finished rebase left the conflict`,
      "  resolved by hand, redo it from the branch's earlier tip (`git reflog`).",
    ]);
  }
  const elsewhere = unmergedElsewhere();
  if (elsewhere.length > 0) {
    refuse([
      "  Resolve the other conflicts first; drizzle-kit reads schema.ts and what it imports:",
      ...listing(elsewhere),
    ]);
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), "swizzle-migration-rebase-"));
  try {
    const out = extract("HEAD", scratch);
    const commit = git("rev-parse", "--short", "REBASE_HEAD");
    const branch = added(extract("REBASE_HEAD", scratch), extract("REBASE_HEAD^", scratch));
    if (branch.length === 0) return [`${commit} adds no migration; nothing to do`];
    const base = journal(out);
    const landed = new Set(
      base.flatMap(({ sqlPath }) => statements(readFileSync(sqlPath, "utf8"))),
    );
    const renumbered: Renumbered[] = [];
    const problems: string[] = [];
    const earlier: string[] = [];
    for (const migration of branch) {
      const result = regenerate(migration, out, landed, earlier);
      if (typeof result === "string") {
        problems.push(`  ${result}`);
      } else {
        renumbered.push(result);
        if (result.to !== undefined) {
          earlier.push(...statements(readFileSync(path.join(out, `${result.to}.sql`), "utf8")));
        }
      }
    }
    if (problems.length > 0) refuse(problems);
    replace(out);
    return [
      `${commit}'s migrations follow HEAD's ${base.at(-1)?.tag ?? "first migration"}`,
      ...renumbered.map(({ from, to, note }) => `  ${from} -> ${to ?? "(none)"} (${note})`),
      `Staged ${tracked}. Next: git rebase --continue`,
    ];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  console.log(`db-migration-rebase: ${rebase().join("\n")}`);
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  console.error(`db-migration-rebase: ${tracked} is unchanged\n${error.message}`);
  process.exitCode = 1;
}
