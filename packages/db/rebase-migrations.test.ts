import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import { temporaryDirectory } from "../../test/support.js";
import { journal, statements } from "./migration-files.js";

const source = fileURLToPath(new URL(".", import.meta.url));
const seed = 'INSERT INTO "items" ("id") VALUES (42);';
const addLabel = 'ALTER TABLE "items" ADD COLUMN "label" text;';
const addNote = 'ALTER TABLE "items" ADD COLUMN "note" text;';
const schema = (columns = "") =>
  `import { pgTable, integer, text } from 'drizzle-orm/pg-core';\nexport const items = pgTable('items', { id: integer('id')${columns} });\n`;
const snapshot = (label: "none" | "nullable" | "required" = "none", note = false) =>
  generateDrizzleJson({
    items: pgTable("items", {
      id: integer("id"),
      ...(label === "none"
        ? {}
        : { label: label === "required" ? text("label").notNull() : text("label") }),
      ...(note ? { note: text("note") } : {}),
    }),
  });
type Snapshot = ReturnType<typeof snapshot>;

/** Each case owns a real stopped Git rebase and real Drizzle SQL, snapshots and journal. */
async function fixture() {
  const root = await temporaryDirectory("swizzle-migration-test-");
  const db = path.join(root, "packages/db");
  const out = path.join(db, "drizzle");
  await mkdir(path.join(out, "meta"), { recursive: true });
  await mkdir(path.join(db, "src"));
  for (const file of ["rebase-migrations.ts", "migration-files.ts", "drizzle.config.ts"]) {
    await cp(path.join(source, file), path.join(db, file));
  }
  await symlink(path.join(source, "node_modules"), path.join(db, "node_modules"), "dir");
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(root, "justfile"),
    `db-migration-rebase:\n    ${process.execPath} --import tsx packages/db/rebase-migrations.ts\n`,
  );
  await symlink(path.resolve(source, "../../node_modules"), path.join(root, "node_modules"), "dir");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HUSKY: "0", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "target");
  git("config", "user.name", "Migration test");
  git("config", "user.email", "migration@swizzle.test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
  };
  const append = async (name: string, next: Snapshot, sql: string) => {
    const journalPath = path.join(out, "meta/_journal.json");
    const data = JSON.parse(
      await readFile(journalPath, "utf8").catch(
        () => '{"version":"7","dialect":"postgresql","entries":[]}',
      ),
    );
    const idx = data.entries.length;
    const tag = `${String(idx).padStart(4, "0")}_${name}`;
    const previous =
      idx === 0
        ? undefined
        : JSON.parse(
            await readFile(
              path.join(out, "meta", `${String(idx - 1).padStart(4, "0")}_snapshot.json`),
              "utf8",
            ),
          );
    data.entries.push({ idx, version: "7", when: idx + 1, tag, breakpoints: true });
    await writeFile(journalPath, JSON.stringify(data));
    await writeFile(
      path.join(out, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`),
      JSON.stringify({ ...next, id: randomUUID(), prevId: previous?.id ?? next.prevId }),
    );
    await writeFile(path.join(out, `${tag}.sql`), sql);
  };
  const initial = snapshot();
  await writeFile(path.join(db, "src/schema.ts"), schema());
  await append(
    "base",
    initial,
    (await generateMigration(generateDrizzleJson({}), initial)).join(
      "\n--> statement-breakpoint\n",
    ),
  );
  commit();
  const base = git("rev-parse", "HEAD");
  const stop = async (options: { landed?: Snapshot; landedSql?: string; current: string }) => {
    commit();
    git("checkout", "-qb", "landed", base);
    await append(
      "landed",
      options.landed ?? initial,
      options.landedSql ?? 'INSERT INTO "items" ("id") VALUES (1);',
    );
    commit();
    const landed = git("rev-parse", "HEAD");
    git("checkout", "target");
    expect(() => git("rebase", "landed")).toThrow();
    expect(git("rev-parse", "HEAD")).toBe(landed);
    await writeFile(path.join(db, "src/schema.ts"), options.current);
    git("add", "packages/db/src/schema.ts");
  };
  const run = () => {
    try {
      return {
        code: 0,
        output: execFileSync("just", ["db-migration-rebase"], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (error) {
      if (!(error instanceof Error) || !("stdout" in error) || !("stderr" in error)) throw error;
      return { code: 1, output: `${error.stdout}${error.stderr}` };
    }
  };
  const sql = async () =>
    Promise.all(
      journal(out)
        .slice(2)
        .map(({ sqlPath }) => readFile(sqlPath, "utf8")),
    );
  const tree = async () => {
    const files = await readdir(out, { recursive: true, withFileTypes: true });
    return Promise.all(
      files
        .filter((entry) => entry.isFile())
        .map(async (entry) => [
          entry.name,
          await readFile(path.join(entry.parentPath, entry.name), "utf8"),
        ]),
    );
  };
  return { root, append, stop, run, sql, tree, initial, git };
}

test("keeps every byte of a custom migration", async () => {
  const f = await fixture();
  await f.append("custom", f.initial, `${seed}\n-- a hand-written explanation\n`);
  await f.stop({ current: schema() });
  expect(f.run()).toMatchObject({
    code: 0,
    output: expect.stringContaining("hand-written, SQL kept"),
  });
  expect(await f.sql()).toEqual([`${seed}\n-- a hand-written explanation\n`]);
});

test("refuses an absorbed migration without changing or staging conflicted files", async () => {
  const f = await fixture();
  await f.append("label", snapshot("nullable"), addLabel);
  await f.append("note", snapshot("nullable", true), addNote);
  await f.stop({ current: schema(', label: text("label"), note: text("note")') });
  const before = await f.tree();
  const index = f.git("ls-files", "--stage");
  expect(f.run()).toMatchObject({
    code: 1,
    output: expect.stringContaining(
      "an earlier migration of this commit now carries its schema change",
    ),
  });
  expect(await f.tree()).toEqual(before);
  expect(f.git("ls-files", "--stage")).toBe(index);
});

test("refuses differently rendered SQL when a hand-written statement needs review", async () => {
  const f = await fixture();
  await f.append(
    "required",
    snapshot("required"),
    `${addLabel.replace("text;", "text NOT NULL;")}\n--> statement-breakpoint\n${seed}`,
  );
  await f.stop({
    landed: snapshot("nullable"),
    landedSql: addLabel,
    current: schema(', label: text("label").notNull()'),
  });
  const before = await f.tree();
  expect(f.run()).toMatchObject({ code: 1, output: expect.stringContaining(seed) });
  expect(await f.tree()).toEqual(before);
});

test("drops a schema change already applied on the target", async () => {
  const f = await fixture();
  await f.append("label", snapshot("nullable"), addLabel);
  await f.stop({
    landed: snapshot("nullable"),
    landedSql: addLabel,
    current: schema(', label: text("label")'),
  });
  expect(f.run()).toMatchObject({
    code: 0,
    output: expect.stringContaining("dropped, HEAD's migrations already make its change"),
  });
  expect(await f.sql()).toEqual([]);
  expect(f.git("diff", "--name-only", "--diff-filter=U")).toBe("");
});

test("reduces an applied schema change to its surviving hand-written SQL", async () => {
  const f = await fixture();
  await f.append("label", snapshot("nullable"), `${addLabel}\n--> statement-breakpoint\n${seed}`);
  await f.stop({
    landed: snapshot("nullable"),
    landedSql: addLabel,
    current: schema(', label: text("label")'),
  });
  expect(f.run()).toMatchObject({
    code: 0,
    output: expect.stringContaining("kept 1 hand-written statement(s)"),
  });
  expect((await f.sql()).map(statements)).toEqual([[seed]]);
});

test("regenerates a changed schema delta on the target", async () => {
  const f = await fixture();
  await f.append("label", snapshot("nullable"), addLabel);
  await f.stop({
    landed: snapshot("nullable"),
    landedSql: addLabel,
    current: schema(', label: text("label").notNull()'),
  });
  expect(f.run()).toMatchObject({ code: 0, output: expect.stringContaining("SQL regenerated") });
  expect((await f.sql()).map(statements)).toEqual([
    ['ALTER TABLE "items" ALTER COLUMN "label" SET NOT NULL;'],
  ]);
});

test("keeps unchanged schema SQL and its hand-written statements in order", async () => {
  const f = await fixture();
  const sql = `${addLabel}\n--> statement-breakpoint\n${seed}`;
  await f.append("label", snapshot("nullable"), sql);
  await f.stop({ current: schema(', label: text("label")') });
  expect(f.run()).toMatchObject({
    code: 0,
    output: expect.stringContaining("kept 1 hand-written statement(s)"),
  });
  expect(await f.sql()).toEqual([sql]);
});

test("keeps generated SQL unchanged", async () => {
  const f = await fixture();
  await f.append("label", snapshot("nullable"), addLabel);
  await f.stop({ current: schema(', label: text("label")') });
  expect(f.run()).toMatchObject({ code: 0, output: expect.stringContaining("SQL unchanged") });
  expect(await f.sql()).toEqual([addLabel]);
});

for (const kind of ["column", "table"] as const) {
  for (const rename of [false, true]) {
    test.skipIf(process.platform !== "linux")(
      `a terminal can resolve a ${kind} ${rename ? "rename" : "replacement"}`,
      async ({ signal, onTestFinished }) => {
        const f = await fixture();
        let sql: string[];
        if (kind === "column" && rename) {
          sql = ['ALTER TABLE "items" RENAME COLUMN "id" TO "next";'];
        } else if (kind === "column") {
          sql = [
            'ALTER TABLE "items" ADD COLUMN "next" integer;',
            'ALTER TABLE "items" DROP COLUMN "id";',
          ];
        } else if (rename) {
          sql = ['ALTER TABLE "items" RENAME TO "next_items";'];
        } else {
          sql = ['CREATE TABLE "next_items" (\n\t"id" integer\n);', 'DROP TABLE "items" CASCADE;'];
        }
        await f.append(
          `replace_${kind}`,
          generateDrizzleJson({
            items:
              kind === "column"
                ? pgTable("items", { next: integer("next") })
                : pgTable("next_items", { id: integer("id") }),
          }),
          sql.join("\n--> statement-breakpoint\n"),
        );
        await f.stop({
          current:
            kind === "column"
              ? "import { pgTable, integer } from 'drizzle-orm/pg-core'; export const items = pgTable('items', { next: integer('next') });"
              : "import { pgTable, integer } from 'drizzle-orm/pg-core'; export const items = pgTable('next_items', { id: integer('id') });",
        });
        const child = spawn("script", ["-qefc", "just db-migration-rebase", "/dev/null"], {
          cwd: f.root,
          signal,
        });
        onTestFinished(() => {
          child.kill();
        });
        let output = "";
        let answered = false;
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (!answered && output.includes(`create ${kind}`)) {
            answered = true;
            child.stdin.write(rename ? "\u001b[B\r" : "\r");
          }
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const [code] = await once(child, "exit");
        expect(code, output).toBe(0);
        expect((await f.sql()).map(statements)).toEqual([sql]);
      },
    );
  }
}
