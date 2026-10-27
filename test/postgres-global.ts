import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";
import { createDatabaseClient, type DatabaseClient } from "../packages/db/src/client.js";

export default async function setup(project: TestProject) {
  const name = `swizzle-tests-${randomUUID()}`;
  const password = randomUUID();
  const compose = (...args: string[]) =>
    execFileSync(
      "docker",
      ["compose", "-p", name, "-f", "infra/docker/compose.test.yml", ...args],
      {
        env: {
          ...process.env,
          POSTGRES_USER: "swizzle",
          POSTGRES_DB: "swizzle",
          POSTGRES_PASSWORD: password,
          VALKEY_PASSWORD: password,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.off("exit", stop);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    compose("down", "-v");
  };
  const stopForSignal = (signal: NodeJS.Signals) => {
    try {
      stop();
    } finally {
      // Restore the default signal exit after releasing the run's detached database.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    }
  };
  const interrupt = () => stopForSignal("SIGINT");
  const terminate = () => stopForSignal("SIGTERM");
  process.once("exit", stop);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    compose("up", "-d", "--wait", "postgres");
    const address = compose("port", "postgres", "5432").trim();
    const url = `postgresql://swizzle:${password}@${address}/swizzle`;
    const client = createDatabaseClient({ connectionString: url });
    try {
      await client.migrate();
      project.provide("postgresResetSql", await resetStatement(client));
    } finally {
      await client.close();
    }
    project.provide("postgresTemplate", url);
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

declare module "vitest" {
  export interface ProvidedContext {
    postgresTemplate: string;
    postgresResetSql: string;
  }
}

/** Capture migration seeds once. Foreign keys determine their restore order. */
async function resetStatement(client: DatabaseClient): Promise<string> {
  const tables = await client.pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const references = await client.pool.query<{ child: string; parent: string }>(
    "SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace",
  );
  const seeds = new Map<string, string[]>();
  for (const { tablename } of tables.rows) {
    const rows = await client.pool.query<{ row: string }>(
      `SELECT row_to_json(t)::text AS row FROM "${tablename}" t`,
    );
    if (rows.rowCount)
      seeds.set(
        tablename,
        rows.rows.map(
          ({ row }) =>
            `INSERT INTO "${tablename}" SELECT * FROM json_populate_record(NULL::"${tablename}", '${row.replaceAll("'", "''")}');`,
        ),
      );
  }
  const ordered: string[] = [];
  while (seeds.size > 0) {
    const next = [...seeds.keys()].find((name) =>
      references.rows.every(
        ({ child, parent }) => child !== name || parent === name || !seeds.has(parent),
      ),
    );
    if (next === undefined) throw new Error("Migration seed rows have cyclic foreign keys.");
    ordered.push(...(seeds.get(next) ?? []));
    seeds.delete(next);
  }
  return `TRUNCATE ${tables.rows.map(({ tablename }) => `"${tablename}"`).join(",")} CASCADE; ${ordered.join("\n")}`;
}
