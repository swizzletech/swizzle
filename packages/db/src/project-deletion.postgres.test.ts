import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  commitDeploymentFixture,
  createQueuedRun,
} from "../../../scripts/verify-state-fixtures.js";
import { testDatabase, untilLockWaiters } from "../../../test/postgres.js";
import { testAccessStore, testControlPlaneStore } from "../../../test/stores.js";
import { waitFor } from "../../../test/support.js";
import { causeCode } from "./client.js";

it("checks for unfinished runs when deployment adds an automation during project deletion", async ({
  signal,
}) => {
  const database = testDatabase();
  const store = testControlPlaneStore();
  const project = await testAccessStore().createProject({
    name: "Concurrent project",
    slug: "concurrent",
  });
  const first = await commitDeploymentFixture(store, "first-automation", project.id);
  const automationLock = await database.pool.connect();
  const runsLock = await database.pool.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await automationLock.query("BEGIN");
    await automationLock.query("SELECT id FROM automations WHERE id = $1 FOR UPDATE", [
      first.automationId,
    ]);
    const deletion = store
      .deleteProject({ projectId: project.id, contents: { kind: "delete" } })
      .then(
        () => "deleted",
        (error: unknown) => causeCode(error),
      );
    pending.push(deletion);
    await untilLockWaiters(database, 1);

    const second = await commitDeploymentFixture(store, "second-automation", project.id);
    await runsLock.query("BEGIN");
    await runsLock.query("LOCK TABLE runs IN SHARE MODE");
    const runId = randomUUID();
    const queueing = createQueuedRun(store, second, runId, runId, {}).then(
      () => "queued",
      (error: unknown) => causeCode(error),
    );
    pending.push(queueing);
    await untilLockWaiters(database, 2);
    const run = await database.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query LIKE 'insert into "runs"%'`,
    );
    expect(run.rows).toHaveLength(1);
    await automationLock.query("COMMIT");
    const deletionBlocksOnRun = `SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND $1 = ANY(pg_blocking_pids(pid))
    ) AS blocked`;
    await waitFor(signal, async () => {
      const state = await database.pool.query<{ blocked: boolean }>(deletionBlocksOnRun, [
        run.rows[0]?.pid,
      ]);
      return state.rows[0]?.blocked === true;
    });
    await runsLock.query("COMMIT");
    expect(await Promise.all([deletion, queueing])).toEqual(["AUTOMATION_RUNS_ACTIVE", "queued"]);
    expect(await store.getRun(runId)).toMatchObject({ status: "queued", projectId: project.id });
  } finally {
    await automationLock.query("ROLLBACK");
    await runsLock.query("ROLLBACK");
    automationLock.release();
    runsLock.release();
    await Promise.allSettled(pending);
  }
});
