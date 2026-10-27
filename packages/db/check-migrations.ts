// Fails when packages/db/src/schema.ts and the migrations in packages/db/drizzle drift apart.
// `just check` runs this. It proves three things:
//   1. The journal and the files agree: every listed migration has its SQL and snapshot, every
//      SQL file is listed, because the migrator applies only what the journal lists, and each
//      snapshot follows the one before it.
//   2. The baseline SQL is what drizzle-kit renders from the baseline snapshot.
//   3. drizzle-kit renders schema.ts into a snapshot from scratch, which equals the latest one.
// A failure of 1 means two branches added a migration under the same number, and
// `just db-migration-rebase`, run where `git rebase main` stops, renumbers this branch's; a
// failure of 2 or 3 means schema.ts changed without `just db-generate <name>`.
// Later migrations' SQL is not replayed: drizzle-kit asks interactively about renames there, and a
// hand-written data migration is legitimate.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { generateMigration } from "drizzle-kit/api";
import config from "./drizzle.config.ts";
import { hasConflictMarkers, journal, type Migration, statements } from "./migration-files.ts";

type DrizzleSnapshot = Parameters<typeof generateMigration>[0];
interface Snapshot {
  readonly id: string;
  readonly prevId: string;
  readonly tables: Readonly<Record<string, unknown>>;
  readonly [section: string]: unknown;
}

const db = fileURLToPath(new URL(".", import.meta.url));
const migrations = path.join(db, config.out ?? "drizzle");
const shown = (file: string) => path.relative(db, file);

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const conflicted = (file: string) => hasConflictMarkers(readFileSync(file, "utf8"));

function snapshotOfSchema(): Snapshot {
  const out = mkdtempSync(path.join(os.tmpdir(), "swizzle-check-migrations-"));
  try {
    execFileSync(
      "pnpm",
      ["exec", "drizzle-kit", "generate", "--dialect", config.dialect].concat([
        "--schema",
        String(config.schema),
        "--out",
        out,
      ]),
      { cwd: db, stdio: ["ignore", "ignore", "inherit"] },
    );
    return readJson<Snapshot>(path.join(out, "meta/0000_snapshot.json"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const withoutIds = ({ id: _id, prevId: _prevId, ...rest }: Snapshot) => rest;

/**
 * Each problem says how the journal and the files disagree, as they do when two branches each
 * added a migration under the same number; an empty list means `listed` is a sound chain.
 */
function collisions(listed: readonly Migration[]): string[] {
  const missing = listed
    .flatMap(({ sqlPath, snapshot }) => [sqlPath, snapshot])
    .filter((file) => !existsSync(file))
    .map((file) => `${shown(file)} is listed in meta/_journal.json but missing.`);
  const unlisted = readdirSync(migrations)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => path.join(migrations, file))
    .filter((file) => !listed.some(({ sqlPath }) => sqlPath === file))
    .map(
      (file) => `${shown(file)} is not in meta/_journal.json, so the migrator never applies it.`,
    );
  if (missing.length > 0) return [...missing, ...unlisted];

  const snapshots = listed.map(({ snapshot }) => snapshot);
  const unresolved = snapshots
    .filter(conflicted)
    .map((file) => `${shown(file)} holds merge conflict markers.`);
  if (unresolved.length > 0) return [...unresolved, ...unlisted];
  const broken = snapshots.slice(1).flatMap((file, index) => {
    const previous = snapshots[index] as string;
    return readJson<Snapshot>(file).prevId === readJson<Snapshot>(previous).id
      ? []
      : [`${shown(file)} does not follow ${shown(previous)}.`];
  });
  return [...unlisted, ...broken];
}

/** Each problem says how schema.ts and the migrations drifted; an empty list means they agree. */
async function drift(listed: readonly Migration[]): Promise<string[]> {
  const baseline = listed[0];
  const latest = listed.at(-1);
  if (baseline === undefined || latest === undefined) {
    return ["meta/_journal.json lists no migration."];
  }

  const problems: string[] = [];
  const first = readJson<DrizzleSnapshot & Snapshot>(baseline.snapshot);
  const empty = {
    ...first,
    tables: {},
    enums: {},
    schemas: {},
    sequences: {},
    roles: {},
    policies: {},
    views: {},
  };
  const rendered = await generateMigration(empty, first);
  const committedSql = statements(readFileSync(baseline.sqlPath, "utf8"));
  if (
    !isDeepStrictEqual(
      rendered.map((statement) => statement.trim()),
      committedSql,
    )
  ) {
    problems.push(
      `${shown(baseline.sqlPath)} is not the SQL drizzle-kit renders from ${shown(baseline.snapshot)}.`,
    );
  }

  const committed = readJson<Snapshot>(latest.snapshot);
  const schema = snapshotOfSchema();
  if (!isDeepStrictEqual(withoutIds(schema), withoutIds(committed))) {
    const tables = new Set([...Object.keys(schema.tables), ...Object.keys(committed.tables)]);
    const changed = [...tables].filter(
      (table) => !isDeepStrictEqual(schema.tables[table], committed.tables[table]),
    );
    const where =
      changed.length > 0 ? `tables ${changed.join(", ")}` : "enums, schemas or other sections";
    problems.push(
      `src/schema.ts differs from the latest migration snapshot ${shown(latest.snapshot)} in ${where}.`,
    );
  }
  return problems;
}

/** What a kind of problem means, and how to fix it. */
interface Verdict {
  readonly headline: string;
  readonly fix: readonly string[];
}
const collided: Verdict = {
  headline: "the migrations in packages/db/drizzle do not form one chain",
  fix: [
    "This branch and main each added a migration under the same number. Where `git rebase main`",
    "stops on this conflict, run `just db-migration-rebase`: it keeps main's migrations and",
    "regenerates the stopped commit's after them. If a finished rebase left this, redo that rebase",
    "from the branch's earlier tip (`git reflog`).",
  ],
};
const drifted: Verdict = {
  headline: "packages/db/src/schema.ts and packages/db/drizzle drifted apart",
  fix: [
    "A database migrates only through the committed SQL, so it would miss this schema.",
    "Write migrations with `just db-generate` and commit its SQL and snapshot with the schema change.",
  ],
};

async function check(): Promise<{ problems: string[]; verdict: Verdict }> {
  const journalFile = path.join(migrations, "meta/_journal.json");
  if (conflicted(journalFile)) {
    return { problems: [`${shown(journalFile)} holds merge conflict markers.`], verdict: collided };
  }
  const listed = journal(migrations);
  const broken = collisions(listed);
  if (broken.length > 0) return { problems: broken, verdict: collided };
  return { problems: await drift(listed), verdict: drifted };
}

const { problems, verdict } = await check();
if (problems.length === 0) {
  console.log("check-migrations: schema.ts, the journal and the SQL agree");
} else {
  console.error(
    [
      `check-migrations: ${verdict.headline}`,
      ...problems.map((problem) => `  ${problem}`),
      ...verdict.fix,
    ].join("\n"),
  );
  process.exitCode = 1;
}
