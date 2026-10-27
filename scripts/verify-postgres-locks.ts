import type { DatabaseClient } from "@swizzle/db/postgres";

export async function lockWaiters(client: DatabaseClient): Promise<number> {
  const waiting = await client.pool.query<{ count: string }>(
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
  );
  return Number(waiting.rows[0]?.count);
}
