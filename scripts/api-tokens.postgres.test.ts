import assert from "node:assert/strict";
import { FULL_SCOPE } from "@swizzle/db";
import {
  createPostgresApiTokenStore,
  createPostgresWorkerRegistry,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { it } from "vitest";
import { lockWaiters, testDatabase } from "../test/postgres.js";
import { waitFor } from "../test/support.js";

async function verifyApiTokenTouch(client: DatabaseClient, signal: AbortSignal): Promise<void> {
  const store = createPostgresApiTokenStore({ client });
  const person = await client.pool.query<{ id: string }>(
    "INSERT INTO auth_users (name, email) VALUES ('verify', 'verify-touch@example.test') RETURNING id",
  );
  const userId = person.rows[0]?.id;
  assert.ok(userId, "person row exists");
  const { id, token } = await store.createToken({
    holder: { kind: "person", userId },
    issuedBy: { id: userId, name: "verify" },
    name: "verify-touch",
    scope: FULL_SCOPE,
  });
  await verifyTouch(client, id, token, signal);
  const registry = createPostgresWorkerRegistry({ client });
  const enrollment = await registry.create({
    name: "verify-token-touch",
    profiles: [],
    services: [],
    environments: [],
    issuedBy: null,
  });
  const worker = await registry.enroll(enrollment.code, "verify-token-touch");
  const verified = await store.verifyToken(worker.token);
  assert.ok(verified?.holder.kind === "worker");
  await verifyTouch(client, verified.id, worker.token, signal);
  const lock = await client.pool.connect();
  const watching = new AbortController();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT 1 FROM workers WHERE id = $1 FOR UPDATE", [worker.worker.id]);
    await lock.query("SELECT 1 FROM api_tokens WHERE id = $1 FOR UPDATE", [verified.id]);
    const authenticated = await Promise.race([
      store.verifyToken(worker.token).then(async (credential) => {
        assert.ok(credential?.holder.kind === "worker");
        return registry.authenticate(credential.holder.workerId, credential.id);
      }),
      waitFor(watching.signal, async () => (await lockWaiters(client)) > 0).then(() => {
        throw new Error("WORKER_AUTH_WAITED_FOR_ROW_LOCK");
      }),
    ]);
    assert.equal(authenticated.id, worker.worker.id);
  } finally {
    watching.abort();
    lock.release(true);
  }
  process.stdout.write(
    "Postgres worker tokens: throttled touch under bursts; authentication completes with both credential and identity rows locked elsewhere.\n",
  );
}

async function verifyTouch(
  client: DatabaseClient,
  id: string,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const store = createPostgresApiTokenStore({ client });
  await client.pool.query("UPDATE api_tokens SET last_used_at = NULL WHERE id = $1", [id]);
  const rowVersion = async (): Promise<string> => {
    const result = await client.pool.query<{ version: string }>(
      "SELECT xmin::text AS version FROM api_tokens WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    assert.ok(row, "token row exists");
    return row.version;
  };

  const created = await rowVersion();
  await store.verifyToken(token);
  const firstUse = await rowVersion();
  assert.notEqual(firstUse, created, "the first use writes last_used_at");
  for (let use = 0; use < 20; use += 1) {
    await store.verifyToken(token);
  }
  assert.equal(await rowVersion(), firstUse, "20 more uses inside the interval write nothing");

  await client.pool.query(
    "UPDATE api_tokens SET last_used_at = now() - interval '2 minutes' WHERE id = $1",
    [id],
  );
  await client.pool.query(
    `CREATE TABLE token_updates (n serial);
     CREATE FUNCTION log_token_update() RETURNS trigger LANGUAGE plpgsql AS
       $$ BEGIN INSERT INTO token_updates DEFAULT VALUES; RETURN NEW; END $$;
     CREATE TRIGGER log_token_update AFTER UPDATE ON api_tokens
       FOR EACH ROW EXECUTE FUNCTION log_token_update()`,
  );

  const burst = 8;
  const lock = await client.pool.connect();
  let settledUses = 0;
  let uses: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT 1 FROM api_tokens WHERE id = $1 FOR UPDATE", [id]);
    uses = Promise.allSettled(
      Array.from({ length: burst }, () =>
        store.verifyToken(token).finally(() => {
          settledUses += 1;
        }),
      ),
    );
    await waitFor(
      signal,
      async () => settledUses >= burst || (await lockWaiters(client)) + settledUses >= burst,
    );
  } finally {
    lock.release(true);
    await uses;
  }
  const failedUse = (await uses).find((use) => use.status === "rejected");
  if (failedUse !== undefined)
    throw new Error("TOKEN_BURST_USE_FAILED", { cause: failedUse.reason });
  const updates = await client.pool.query<{ count: string }>("SELECT count(*) FROM token_updates");
  assert.equal(Number(updates.rows[0]?.count), 1, "a burst after the interval writes exactly once");
  const afterBurst = await rowVersion();
  await store.verifyToken(token);
  assert.equal(await rowVersion(), afterBurst, "the use after that writes nothing again");
  await client.pool.query(
    `DROP TRIGGER log_token_update ON api_tokens;
     DROP FUNCTION log_token_update();
     DROP TABLE token_updates`,
  );
  process.stdout.write(
    "Postgres api tokens: last_used_at written once per interval, also under a burst, passed.\n",
  );
}

it("writes token last use once per interval even under concurrent requests", async ({ signal }) => {
  const client = testDatabase();
  await verifyApiTokenTouch(client, signal);
});
