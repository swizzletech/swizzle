// Each file owns a database cloned from the run's migrated template. Stores share its client,
// so transactions, foreign keys and authentication use exactly the production implementation.
import { randomUUID } from "node:crypto";
import { createDatabaseClient, type DatabaseClient } from "@swizzle/db/postgres";
import { afterAll, beforeAll, beforeEach, inject, onTestFinished, vi } from "vitest";
import { waitFor } from "./support.js";

// Docker lifecycle tests reload modules. Vitest isolates globals per file, so their client
// survives vi.resetModules without reaching another file or worker.
declare global {
  var swizzleTestDatabase: DatabaseClient | undefined;
}

export function testDatabase(): DatabaseClient {
  if (globalThis.swizzleTestDatabase === undefined)
    throw new Error("This test needs the postgres Vitest project.");
  return globalThis.swizzleTestDatabase;
}

export function usePostgresDatabase() {
  let owned: Awaited<ReturnType<typeof cloneDatabase>>;
  beforeAll(async () => {
    owned = await cloneDatabase();
    globalThis.swizzleTestDatabase = owned.client;
  });
  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", owned.url);
    await testDatabase().pool.query(inject("postgresResetSql"));
  });
  afterAll(async () => {
    globalThis.swizzleTestDatabase = undefined;
    await owned?.close();
  });
}

/** Another instance in the same test, with its own rows and connections. */
export async function additionalDatabase(): Promise<DatabaseClient> {
  const owned = await cloneDatabase();
  onTestFinished(() => owned.close());
  return owned.client;
}

/** Sessions of the client's database that wait on a lock: a row, a table or an advisory lock. */
export async function lockWaiters(client: DatabaseClient): Promise<number> {
  const waiting = await client.pool.query<{ count: string }>(
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
  );
  return Number(waiting.rows[0]?.count);
}

/**
 * Resolves once at least `count` sessions wait on a lock: the state a race test needs before it
 * lets the lock holder go. The test timeout bounds the wait, and the poll stops when the test ends.
 */
export async function untilLockWaiters(client: DatabaseClient, count: number): Promise<void> {
  const finished = new AbortController();
  onTestFinished(() => finished.abort());
  await waitFor(finished.signal, async () => (await lockWaiters(client)) >= count);
}

async function cloneDatabase() {
  const template = new URL(inject("postgresTemplate"));
  const databaseName = `test_${randomUUID().replaceAll("-", "")}`;
  const templateName = template.pathname.slice(1);
  const adminUrl = new URL(template);
  adminUrl.pathname = "/postgres";
  const databaseUrl = new URL(template);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createDatabaseClient({ connectionString: adminUrl.toString() });
  try {
    await admin.pool.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${templateName}"`);
  } catch (error) {
    await admin.close();
    throw error;
  }
  const client = createDatabaseClient({ connectionString: databaseUrl.toString() });
  return {
    client,
    url: databaseUrl.toString(),
    async close() {
      try {
        await client.close();
        await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally {
        await admin.close();
      }
    },
  };
}
