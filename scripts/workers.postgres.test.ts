import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import {
  createPostgresAccessStore,
  createPostgresApiTokenStore,
  createPostgresControlPlaneStore,
  createPostgresWorkerRegistry,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { it } from "vitest";
import { testDatabase } from "../test/postgres.js";

/** Real transactions prove single use, revocation races, exact grants, hashes and enrollment budgets. */
async function verifyWorkers(client: DatabaseClient): Promise<void> {
  const registry = createPostgresWorkerRegistry({ client });
  const tokens = createPostgresApiTokenStore({ client });
  const authenticate = async (raw: string) => {
    const verified = await tokens.verifyToken(raw);
    if (verified?.holder.kind !== "worker") {
      throw Object.assign(new Error("Worker credential refused"), { code: "WORKER_FORBIDDEN" });
    }
    return registry.authenticate(verified.holder.workerId, verified.id);
  };
  const issue = (name: string, profiles = ["gpu-home"]) =>
    registry.create({
      name,
      profiles,
      services: [],
      environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "staging" }],
      issuedBy: null,
    });
  const denied = (promise: Promise<unknown>, code: string) =>
    assert.rejects(promise, (error: Error & { code?: string }) => error.code === code);
  const enrollment = await issue("GPU host");
  assert.equal(enrollment.worker.state, "pending");
  const race = await Promise.allSettled([
    registry.enroll(enrollment.code, "enrollment-race-a"),
    registry.enroll(enrollment.code, "enrollment-race-b"),
  ]);
  assert.equal(
    race.filter((result) => result.status === "fulfilled").length,
    1,
    "a code enrolls exactly one worker under a race",
  );
  const accepted = race.find((result) => result.status === "fulfilled");
  assert.ok(accepted && accepted.status === "fulfilled");
  const { token, worker } = accepted.value;
  assert.ok(worker.tokenExpiresAt !== null);
  assert.ok(Date.parse(worker.tokenExpiresAt) > Date.now() + 89 * 24 * 60 * 60_000);
  assert.equal((await registry.list()).find((row) => row.id === worker.id)?.state, "offline");
  assert.equal(JSON.stringify(await registry.list()).includes(token), false);

  const stored = await client.pool.query<{ token_hash: string; enrollment_hash: string | null }>(
    "SELECT t.token_hash, w.enrollment_hash FROM workers w JOIN api_tokens t ON t.worker_id = w.id WHERE w.id = $1 AND t.revoked_at IS NULL",
    [worker.id],
  );
  assert.deepEqual(stored.rows, [
    { token_hash: createHash("sha256").update(token).digest("hex"), enrollment_hash: null },
  ]);
  assert.equal((await authenticate(token)).id, worker.id);
  assert.equal((await registry.heartbeat(worker)).state, "online");
  assert.equal(
    (
      await registry.session(worker, {
        profile: "gpu-home",
        projectId: DEFAULT_PROJECT_ID,
        environment: "staging",
      })
    ).id,
    worker.id,
  );
  for (const target of [
    { profile: "gpu-other", projectId: DEFAULT_PROJECT_ID, environment: "staging" },
    { profile: "gpu-home", projectId: DEFAULT_PROJECT_ID, environment: "production" },
    {
      profile: "gpu-home",
      projectId: "00000000-0000-4000-8000-000000000099",
      environment: "staging",
    },
    { profile: "host-default", projectId: DEFAULT_PROJECT_ID, environment: "staging" },
  ])
    await denied(registry.session(worker, target), "WORKER_SCOPE_DENIED");
  const generation = worker.credentialGeneration;
  const auditBefore = (await registry.audit(worker.id)).length;
  await denied(registry.renew(worker, token), "WORKER_FORBIDDEN");
  assert.equal((await authenticate(token)).credentialGeneration, generation);
  assert.equal((await registry.audit(worker.id)).length, auditBefore);
  const renewalRace = await Promise.allSettled([
    registry.renew(worker, `swz_${randomBytes(32).toString("base64url")}`),
    registry.renew(worker, `swz_${randomBytes(32).toString("base64url")}`),
  ]);
  assert.equal(
    renewalRace.filter((result) => result.status === "fulfilled").length,
    1,
    "one credential generation renews only once",
  );
  const renewed = renewalRace.find((result) => result.status === "fulfilled");
  assert.ok(renewed && renewed.status === "fulfilled");
  await denied(authenticate(token), "WORKER_FORBIDDEN");
  await denied(registry.heartbeat(worker), "WORKER_FORBIDDEN");
  const next = renewed.value;
  assert.equal((await authenticate(next.token)).id, worker.id);
  await registry.revoke(worker.id, null);
  await denied(authenticate(next.token), "WORKER_FORBIDDEN");
  await denied(
    registry.renew(next.worker, `swz_${randomBytes(32).toString("base64url")}`),
    "WORKER_FORBIDDEN",
  );
  await denied(registry.heartbeat(next.worker), "WORKER_FORBIDDEN");
  const revokedAgain = await registry.revoke(worker.id, null);
  assert.equal(revokedAgain.state, "revoked");
  assert.equal(revokedAgain.tokenExpiresAt, next.worker.tokenExpiresAt);
  assert.equal(
    (await registry.audit(worker.id)).filter((event) => event.change.action === "revoked").length,
    1,
  );
  assert.equal(
    (await registry.audit(worker.id)).filter((event) => event.change.action === "scope-denied")
      .length,
    4,
  );

  const noDefault = await issue("Unassigned", []);
  const unassigned = await registry.enroll(noDefault.code, "no-default");
  await denied(
    registry.session(unassigned.worker, {
      profile: "host-default",
      projectId: DEFAULT_PROJECT_ID,
      environment: "staging",
    }),
    "WORKER_SCOPE_DENIED",
  );
  await client.pool.query(
    "UPDATE workers SET last_seen_at = now() - interval '61 seconds' WHERE id = $1",
    [unassigned.worker.id],
  );
  assert.equal(
    (await registry.list()).find((row) => row.id === unassigned.worker.id)?.state,
    "offline",
  );
  const expired = await issue("Expired enrollment");
  await client.pool.query(
    "UPDATE workers SET enrollment_expires_at = now() - interval '1 second' WHERE id = $1",
    [expired.worker.id],
  );
  await denied(registry.enroll(expired.code, "expired-code"), "WORKER_FORBIDDEN");
  await registry.revoke(expired.worker.id, null);
  await denied(registry.enroll(expired.code, "revoked-code"), "WORKER_FORBIDDEN");

  const limited = await registry.enroll((await issue("Expired token")).code, "expiry-code");
  await client.pool.query(
    "UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE worker_id = $1",
    [limited.worker.id],
  );
  await denied(authenticate(limited.token), "WORKER_FORBIDDEN");
  await denied(
    registry.renew(limited.worker, `swz_${randomBytes(32).toString("base64url")}`),
    "WORKER_FORBIDDEN",
  );
  for (let request = 0; request < 10; request += 1)
    await denied(registry.enroll("wrong-code", "bad-client"), "WORKER_FORBIDDEN");
  await denied(registry.enroll("another-wrong-code", "bad-client"), "WORKER_BUDGET_EXCEEDED");
  const access = createPostgresAccessStore({ client });
  const store = createPostgresControlPlaneStore({ client });
  const project = await access.createProject({ name: "Worker grants", slug: "worker-grants" });
  const scoped = await registry.create({
    name: "Project-scoped worker",
    profiles: ["host-default"],
    services: [],
    issuedBy: null,
    environments: [
      { projectId: project.id, environment: "staging" },
      { projectId: DEFAULT_PROJECT_ID, environment: "staging" },
    ],
  });
  assert.equal(scoped.worker.environments === "all" ? -1 : scoped.worker.environments.length, 2);
  assert.equal(
    (await store.deleteProject({ contents: null, projectId: project.id })).contents,
    "empty",
  );
  assert.deepEqual(
    (await registry.list()).find((row) => row.id === scoped.worker.id)?.environments,
    [{ projectId: DEFAULT_PROJECT_ID, environment: "staging" }],
    "deleting a project removes only that machine grant",
  );
  const storedGrants = await client.pool.query(
    "SELECT project_id, environment FROM worker_grants WHERE worker_id = $1",
    [scoped.worker.id],
  );
  assert.deepEqual(storedGrants.rows, [{ project_id: DEFAULT_PROJECT_ID, environment: "staging" }]);
  process.stdout.write(
    "Postgres workers: single-use enrollment and renewal races, hashes, exact grants, offline state, revocation, expiry, audit persistent enrollment budgets and project grant cascades passed.\n",
  );
}

it("workers", async () => {
  const client = testDatabase();
  await verifyWorkers(client);
});
