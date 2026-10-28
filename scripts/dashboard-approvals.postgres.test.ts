import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ControlPlaneStore, ExecutionWait, RunWait, StoredDeployment } from "@swizzle/db";
import { createDashboardStore, type DatabaseClient } from "@swizzle/db/postgres";
import { it } from "vitest";
import { testDatabase } from "../test/postgres.js";
import { testControlPlaneStore } from "../test/stores.js";
import { commitDeploymentFixture, createQueuedRun } from "./verify-state-fixtures.js";

/**
 * Runs › Needs you reads the current wait from the run, regardless of the waits earlier executions suspended at.
 */
const ANNA = {
  kind: "user",
  label: "anna@example.com",
  userId: "00000000-0000-4000-8000-0000000000a1",
} as const;

async function verifyApprovalWaitQuery(
  client: DatabaseClient,
  store: ControlPlaneStore,
  deployment: StoredDeployment,
): Promise<void> {
  const waitingRun = async (
    reason: "approval" | "event" | "sleep",
    earlierWaits: readonly ExecutionWait[],
  ) => {
    const runId = randomUUID();
    await createQueuedRun(store, deployment, runId, `job-${runId}`, { case: "approval-query" });
    for (const [index, wait] of earlierWaits.entries()) {
      const startedAt = new Date().toISOString();
      await store.createRunExecution({
        workerName: "verification",
        executionNumber: index + 1,
        attempt: 1,
        queueJobId: `job-${runId}`,
        runId,
        startedAt,
        status: "running",
      });
      await store.completeRunExecution({
        executionNumber: index + 1,
        durationMs: 0,
        finishedAt: startedAt,
        runId,
        status: "suspended",
        stderr: "",
        stdout: "",
        wait,
      });
    }
    let wait: RunWait;
    switch (reason) {
      case "sleep":
        wait = { reason, stepKey: "gate", until: "2030-01-01T00:00:00.000Z" };
        break;
      case "approval":
        wait = {
          reason,
          stepKey: "gate",
          assignee: ANNA,
          details: { message: "Review this run" },
          until: null,
          startedAt: new Date().toISOString(),
        };
        break;
      case "event":
        wait = {
          reason,
          stepKey: "gate",
          details: null,
          until: null,
          startedAt: new Date().toISOString(),
        };
        break;
    }

    await store.updateRunState({
      attemptsMade: 1,
      runId,
      status: "waiting",
      wait,
    });
    return runId;
  };
  // Only the run's current wait decides the filter, not a wait an earlier execution suspended at.
  const approval = await waitingRun("approval", [{ reason: "event", stepKey: "signal" }]);
  await waitingRun("event", [{ reason: "approval", stepKey: "gate" }]);
  await waitingRun("sleep", [
    { reason: "approval", stepKey: "gate" },
    { reason: "sleep", stepKey: "nap" },
  ]);

  const listed = await createDashboardStore({ client }).listRuns({
    approvalOnly: true,
    environment: deployment.environment,
    scope: { all: true },
  });
  assert.deepEqual(
    listed.runs.map((run) => run.runId),
    [approval],
  );
  assert.deepEqual(listed.runs[0]?.approval, {
    assignee: ANNA,
    details: { message: "Review this run" },
    stepKey: "gate",
  });

  // Needs you filters by assignee before the limit, so newer approvals for others hide none of
  // Anna's: two for a team she is not in come after hers, and a limit of one still finds hers.
  const finance = {
    kind: "team",
    label: "Finance",
    teamId: "00000000-0000-4000-8000-0000000000f1",
  } as const;
  for (const _ of [1, 2]) {
    const other = await waitingRun("approval", []);
    await client.pool.query(
      "UPDATE runs SET wait = jsonb_set(wait, '{assignee}', $1::jsonb) WHERE id = $2",
      [finance, other],
    );
  }
  const forAnna = await createDashboardStore({ client }).listRuns({
    approvalOnly: true,
    assignedTo: [{ kind: "user", userId: ANNA.userId }],
    environment: deployment.environment,
    limit: 1,
    scope: { all: true },
  });
  assert.deepEqual(
    forAnna.runs.map((run) => run.runId),
    [approval],
    "an approval assigned to Anna stays in reach behind newer ones for Finance",
  );
  const forFinance = await createDashboardStore({ client }).listRuns({
    approvalOnly: true,
    assignedTo: [{ kind: "team", teamId: finance.teamId }],
    environment: deployment.environment,
    scope: { all: true },
  });
  assert.equal(forFinance.runs.length, 2, "a team member sees the team's approvals");
}

it("approval wait query", async () => {
  const client = testDatabase();
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-machine");
  await verifyApprovalWaitQuery(client, store, deployment);
});
