import { it } from "vitest";
import { testDatabase, untilLockWaiters } from "../test/postgres.js";
import { testControlPlaneStore } from "../test/stores.js";
// Run history expiry and project deletion on PostgreSQL (ADR 0015): a finished run past the
// cutoff goes with its executions and logs while a waiting
// run of the same age stays; a project with contents is refused without a choice; moving keeps the
// automations' credential bindings and runs in the target project; deleting leaves nothing of the
// project but its audit events; a delete that meets a run being created waits for it.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ControlPlaneStore } from "@swizzle/db";
import {
  createPostgresAccessStore,
  createPostgresAuditStore,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { commitDeploymentFixture, createQueuedRun } from "./verify-state-fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function verifyHistoryDeletion(
  client: DatabaseClient,
  store: ControlPlaneStore,
): Promise<void> {
  await verifyRunExpiry(client, store);
  await verifyProjectDeletion(client, store);
  await verifyDeletionBesideRunCreation(client, store);
  process.stdout.write(
    "Postgres history: finished runs expire with their executions while waiting runs stay, a project's contents move or go with it while its audit events stay, and a delete beside a run being created refuses instead of deadlocking passed.\n",
  );
}

async function verifyRunExpiry(client: DatabaseClient, store: ControlPlaneStore): Promise<void> {
  const deployment = await commitDeploymentFixture(store, "history-expiry");
  const age = (runId: string, status: string) =>
    client.pool.query(
      "UPDATE runs SET status = $2, finished_at = now() - interval '40 days', queued_at = now() - interval '40 days' WHERE id = $1",
      [runId, status],
    );
  const finished = randomUUID();
  const waiting = randomUUID();
  const recent = randomUUID();
  for (const runId of [finished, waiting, recent]) {
    await createQueuedRun(store, deployment, runId, `history-${runId}`, {});
  }
  await store.createRunExecution({
    executionNumber: 1,
    attempt: 1,
    queueJobId: `history-${finished}`,
    runId: finished,
    startedAt: new Date(Date.now() - 40 * DAY_MS).toISOString(),
    status: "running",
    workerName: "verification",
  });
  await store.appendRunExecutionOutput({
    executionNumber: 1,
    runId: finished,
    stderr: "old log\n",
  });
  await age(finished, "succeeded");
  await age(waiting, "waiting");
  await client.pool.query(
    "UPDATE runs SET status = 'failed', finished_at = now() - interval '1 day' WHERE id = $1",
    [recent],
  );

  const result = await store.expireRuns({
    environment: "state-machine",
    cutoff: new Date(Date.now() - 30 * DAY_MS).toISOString(),
  });
  assert.equal(result.runsDeleted, 1);
  assert.equal(await store.getRun(finished), null, "a finished run past the cutoff expires");
  assert.equal((await store.getRun(waiting))?.status, "waiting", "a waiting run never expires");
  assert.equal((await store.getRun(recent))?.status, "failed", "a recent run stays");
  const executions = await client.pool.query(
    "SELECT count(*) AS n FROM run_executions WHERE run_id = $1",
    [finished],
  );
  assert.equal(Number(executions.rows[0]?.n), 0, "its executions and logs go with it");
}

async function verifyProjectDeletion(
  client: DatabaseClient,
  store: ControlPlaneStore,
): Promise<void> {
  const access = createPostgresAccessStore({ client });
  const audit = createPostgresAuditStore({ client });
  const rejects = (promise: Promise<unknown>, code: string) =>
    assert.rejects(promise, (error: Error & { code?: string }) => error.code === code, code);
  const finishAll = (automationId: string) =>
    client.pool.query(
      "UPDATE runs SET status = 'succeeded', finished_at = now() WHERE automation_id = $1",
      [automationId],
    );
  const production = (projectId: string) => ({ environment: "state-machine", projectId });

  // Moving: the automation, its secret and its run land in the target, and the deployment still
  // binds the secret there.
  const leaving = await access.createProject({ name: "Leaving", slug: "history-leaving" });
  const staying = await access.createProject({ name: "Staying", slug: "history-staying" });
  const secret = await store.upsertSecret({
    ...production(leaving.id),
    name: "HISTORY_TOKEN",
    value: "v1",
  });
  const credential = await store.findCredential("secret", "HISTORY_TOKEN", production(leaving.id));
  const moving = await commitDeploymentFixture(
    store,
    "history-moving",
    leaving.id,
    "state-machine",
    [{ credential: credential ?? assert.fail("credential"), shareId: null }],
  );
  const movingRun = randomUUID();
  await createQueuedRun(store, moving, movingRun, `history-${movingRun}`, {});
  await rejects(
    store.deleteProject({ contents: null, projectId: leaving.id }),
    "PROJECT_NOT_EMPTY",
  );
  assert.deepEqual(await store.countProjectContents(leaving.id), {
    automations: 1,
    credentials: 1,
    runs: 1,
  });

  await store.upsertSecret({ ...production(staying.id), name: "HISTORY_TOKEN", value: "taken" });
  await rejects(
    store.deleteProject({
      contents: { kind: "move", projectId: staying.id },
      projectId: leaving.id,
    }),
    "CREDENTIAL_NAME_CONFLICT",
  );
  const taken = await store.findCredential("secret", "HISTORY_TOKEN", production(staying.id));
  await store.deleteSecret(taken?.id ?? assert.fail("taken secret"));

  const moved = await store.deleteProject({
    contents: { kind: "move", projectId: staying.id },
    projectId: leaving.id,
  });
  assert.deepEqual(moved.counts, { automations: 1, credentials: 1, runs: 1 });
  assert.equal(await access.getProject(leaving.id), null);
  assert.equal((await store.findAutomation("history-moving"))?.projectId, staying.id);
  assert.equal((await store.getRun(movingRun))?.projectId, staying.id);
  assert.deepEqual(
    (await store.boundCredentials(moving.deploymentId, staying.id)).map((bound) => bound.id),
    [secret.id],
    "the moved deployment still binds its moved secret",
  );
  const later = randomUUID();
  await createQueuedRun(store, moving, later, `history-${later}`, {});
  assert.equal((await store.getRun(later))?.projectId, staying.id, "new runs start in the target");

  // Deleting: an unfinished run refuses, then every automation, credential and run goes, the
  // automation's audit event stays.
  const doomed = await access.createProject({ name: "Doomed", slug: "history-doomed" });
  await store.upsertSecret({ ...production(doomed.id), name: "DOOMED_TOKEN", value: "v1" });
  const deleting = await commitDeploymentFixture(store, "history-deleting", doomed.id);
  const deletingRun = randomUUID();
  await createQueuedRun(store, deleting, deletingRun, `history-${deletingRun}`, {});
  const before = await audit.list({ environments: null, limit: 10, projectIds: [doomed.id] });
  assert.ok(before.length > 0, "the deploy wrote an audit event in the project");
  await rejects(
    store.deleteProject({ contents: { kind: "delete" }, projectId: doomed.id }),
    "AUTOMATION_RUNS_ACTIVE",
  );
  await finishAll(deleting.automationId);
  const deleted = await store.deleteProject({ contents: { kind: "delete" }, projectId: doomed.id });
  assert.deepEqual(deleted.counts, { automations: 1, credentials: 1, runs: 1 });
  assert.deepEqual(
    deleted.deletedAutomations.map((automation) => automation.automationSlug),
    ["history-deleting"],
  );
  assert.equal(await access.getProject(doomed.id), null);
  assert.equal(await store.findAutomation("history-deleting"), null);
  assert.equal(await store.getRun(deletingRun), null);
  const left = await client.pool.query(
    `SELECT (SELECT count(*) FROM environment_secrets WHERE project_id = $1)
       + (SELECT count(*) FROM runs WHERE project_id = $1)
       + (SELECT count(*) FROM automations WHERE project_id = $1) AS n`,
    [doomed.id],
  );
  assert.equal(Number(left.rows[0]?.n), 0, "nothing of the project remains");
  assert.deepEqual(
    (await audit.list({ environments: null, limit: 10, projectIds: [doomed.id] })).map(
      (event) => event.id,
    ),
    before.map((event) => event.id),
    "its audit events stay readable",
  );
}

/**
 * A run being created holds its automation shared, then its insert needs the project for the
 * foreign key. A project delete that starts in between waits for the automation and lets the run
 * land, then refuses because of it, instead of deadlocking with the insert.
 */
async function verifyDeletionBesideRunCreation(
  client: DatabaseClient,
  store: ControlPlaneStore,
): Promise<void> {
  const access = createPostgresAccessStore({ client });
  const project = await access.createProject({ name: "Busy", slug: "history-busy" });
  const deployment = await commitDeploymentFixture(store, "history-busy", project.id);
  const template = randomUUID();
  await createQueuedRun(store, deployment, template, `history-${template}`, {});

  const creating = await client.pool.connect();
  try {
    await creating.query("BEGIN");
    await creating.query("SELECT id FROM automations WHERE id = $1 FOR SHARE", [
      deployment.automationId,
    ]);
    const deleting = store.deleteProject({ contents: { kind: "delete" }, projectId: project.id });
    deleting.catch(() => {});
    await untilLockWaiters(client, 1);
    const runId = randomUUID();
    await creating.query(
      `INSERT INTO runs SELECT * FROM jsonb_populate_record(null::runs,
         (SELECT to_jsonb(r) || jsonb_build_object('id', $2::text, 'queue_job_id', $3::text)
          FROM runs r WHERE id = $1))`,
      [template, runId, `history-${runId}`],
    );
    await creating.query("COMMIT");
    await assert.rejects(
      deleting,
      (error: Error & { code?: string }) => error.code === "AUTOMATION_RUNS_ACTIVE",
      "the delete refuses the runs that landed while it waited",
    );
  } finally {
    creating.release();
  }
  assert.ok(await access.getProject(project.id), "the project stays");
}

it("history deletion", async () => {
  const client = testDatabase();
  const store = testControlPlaneStore();
  await verifyHistoryDeletion(client, store);
});
