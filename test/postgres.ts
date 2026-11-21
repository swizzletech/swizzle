import { randomUUID } from "node:crypto";
import { createDatabaseClient, type DatabaseClient } from "@swizzle/db/postgres";
import { afterAll, beforeAll, beforeEach, inject, onTestFinished, vi } from "vitest";
import { waitFor } from "./support.js";

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

export async function additionalDatabase(): Promise<DatabaseClient> {
  const owned = await cloneDatabase();
  onTestFinished(() => owned.close());
  return owned.client;
}

export async function lockWaiters(client: DatabaseClient): Promise<number> {
  const waiting = await client.pool.query<{ count: string }>(
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
  );
  return Number(waiting.rows[0]?.count);
}

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
