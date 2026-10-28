import assert from "node:assert/strict";
import { type DatabaseClient, spendBudget } from "@swizzle/db/postgres";
import { it } from "vitest";
import { testDatabase } from "../test/postgres.js";

/** Schema and budget constraints against the migrated database. */
async function verifyPostgresStores(client: DatabaseClient): Promise<void> {
  const tables = ["grants", "auth_budgets", "worker_grants", "credential_grants"];
  const present = await client.pool.query<{ name: string }>(
    "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL ORDER BY name",
    [tables],
  );
  assert.deepEqual(
    present.rows.map((row) => row.name),
    [...tables].sort(),
  );
  const removed = await client.pool.query(
    "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL",
    [["project_grants", "automation_grants", "environment_grants", "worker_enrollment_budgets"]],
  );
  assert.deepEqual(removed.rows, []);
  const workerColumns = await client.pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'workers' AND column_name IN ('environments', 'budget_started_at', 'budget_used')",
  );
  assert.deepEqual(workerColumns.rows, []);
  process.stdout.write(
    `Postgres schema: current stores ${present.rows.map((row) => row.name).join(", ")}; obsolete grant and budget stores and worker JSON grants absent.\n`,
  );
  const results = await Promise.all(
    Array.from({ length: 12 }, () => spendBudget(client.db, "shared-budget-race", 3, 60_000)),
  );
  assert.equal(
    results.filter((result) => result.allowed).length,
    3,
    "a racing budget admits exactly its limit",
  );
  const spent = await client.pool.query("SELECT attempts FROM auth_budgets WHERE attempts = 12");
  assert.deepEqual(spent.rows, [{ attempts: 12 }], "all attempts spend the same durable window");
  await client.pool.query(
    "UPDATE auth_budgets SET window_ends_at = now() - interval '1 second' WHERE attempts = 12",
  );
  assert.equal((await spendBudget(client.db, "shared-budget-race", 3, 60_000)).allowed, true);
  assert.equal((await spendBudget(client.db, "another-budget", 1, 60_000)).allowed, true);
  process.stdout.write(
    "Postgres budgets: one counter under contention, exact limit, expired window reset and independent keys passed.\n",
  );
}

it("postgres stores", async () => {
  const client = testDatabase();
  await verifyPostgresStores(client);
});
