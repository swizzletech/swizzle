import { randomUUID } from "node:crypto";
import { createDatabaseClient, type DatabaseClient } from "@swizzle/db/postgres";
import { Client } from "pg";

/** A verification owns its schema, including when the worktree's persistent dev schema differs. */
export async function withVerificationDatabase(
  run: (client: DatabaseClient) => Promise<void>,
): Promise<void> {
  const previous = process.env.DATABASE_URL;
  if (previous === undefined)
    throw new Error("Run this verification through just, with its dev databases.");
  const url = new URL(previous);
  const name = `swizzle_dispatch_${randomUUID().replaceAll("-", "")}`;
  url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() });
  let created = false;
  let client: DatabaseClient | undefined;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
    client = createDatabaseClient({ connectionString: url.toString() });
    await client.migrate();
    await run(client);
  } finally {
    try {
      await client?.close();
    } finally {
      process.env.DATABASE_URL = previous;
      try {
        if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }
}
