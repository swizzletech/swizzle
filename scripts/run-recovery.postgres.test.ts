import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ControlPlaneStore, StoredDeployment } from "@swizzle/db";
import { it } from "vitest";
import { testControlPlaneStore } from "../test/stores.js";
import { commitDeploymentFixture, createQueuedRun } from "./verify-state-fixtures.js";

async function verifyQueuedRunRecoveryQuery(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
): Promise<void> {
  const orphanRunId = randomUUID();
  const attemptedRunId = randomUUID();

  await createQueuedRun(store, deployment, orphanRunId, `job-${orphanRunId}`, {
    case: "orphaned-queued",
  });
  await createQueuedRun(store, deployment, attemptedRunId, `job-${attemptedRunId}`, {
    case: "has-attempt",
  });
  await store.createRunExecution({
    workerName: "verification",
    executionNumber: 1,
    attempt: 1,
    queueJobId: `job-${attemptedRunId}`,
    runId: attemptedRunId,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  const orphanedRuns = await store.listQueuedRuns({
    environment: deployment.environment,
  });
  const orphanedRunIds = new Set(orphanedRuns.map((run) => run.runId));
  assert.equal(orphanedRunIds.has(orphanRunId), true);
  assert.equal(orphanedRunIds.has(attemptedRunId), false);

  // Paging one row at a time must visit every row once: queued_at carries microseconds.
  for (const index of [1, 2, 3]) {
    const runId = randomUUID();
    await createQueuedRun(store, deployment, runId, `job-${runId}`, { case: `page-${index}` });
  }
  const everyRunId = (
    await store.listQueuedRuns({ environment: deployment.environment, limit: 1000 })
  ).map((run) => run.runId);
  const pagedRunIds: string[] = [];
  for (;;) {
    const lastRunId = pagedRunIds.at(-1);
    const page = await store.listQueuedRuns({
      ...(lastRunId !== undefined ? { afterRunId: lastRunId } : {}),
      environment: deployment.environment,
      limit: 1,
    });
    if (page.length === 0) break;
    pagedRunIds.push(...page.map((run) => run.runId));
  }
  assert.deepEqual(pagedRunIds, everyRunId, "paging must visit every queued run once, in order");
}

async function verifyDueSleepingRunsCutoff(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
): Promise<void> {
  const dueRunId = randomUUID();
  const futureRunId = randomUUID();
  await createQueuedRun(store, deployment, dueRunId, `job-${dueRunId}`, {
    case: "due-sleep",
  });
  await createQueuedRun(store, deployment, futureRunId, `job-${futureRunId}`, {
    case: "future-sleep",
  });

  await store.updateRunState({
    attemptsMade: 1,
    runId: dueRunId,
    status: "waiting",
    wait: { reason: "sleep", stepKey: "nap", until: "2030-01-01T00:00:00.000Z" },
  });
  await store.updateRunState({
    attemptsMade: 1,
    runId: futureRunId,
    status: "waiting",
    wait: { reason: "sleep", stepKey: "nap", until: "2030-01-01T00:00:00.001Z" },
  });

  const due = await store.listDueSleepingRuns({
    environment: deployment.environment,
    now: "2030-01-01T00:00:00.000Z",
  });
  const dueIds = new Set(due.map((run) => run.runId));
  assert.equal(dueIds.has(dueRunId), true);
  assert.equal(dueIds.has(futureRunId), false);
}

async function verifyQueuedRunsWithAttemptsQuery(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
): Promise<void> {
  const resumableRunId = randomUUID();
  const freshRunId = randomUUID();
  await createQueuedRun(store, deployment, resumableRunId, `job-${resumableRunId}`, {
    case: "resumable-queued",
  });
  await createQueuedRun(store, deployment, freshRunId, `job-${freshRunId}`, {
    case: "fresh-queued",
  });

  const startedAt = new Date(Date.now() - 10_000).toISOString();
  await store.createRunExecution({
    workerName: "verification",
    executionNumber: 1,
    attempt: 1,
    metadata: { verification: "state-machine" },
    queueJobId: `job-${resumableRunId}`,
    runId: resumableRunId,
    startedAt,
    status: "running",
  });
  await store.completeRunExecution({
    executionNumber: 1,
    durationMs: 1_000,
    finishedAt: new Date().toISOString(),
    wait: { reason: "sleep", stepKey: "nap" },
    runId: resumableRunId,
    status: "suspended",
    stderr: "",
    stdout: "",
  });
  await store.updateRunState({
    attemptsMade: 1,
    runId: resumableRunId,
    status: "queued",
  });

  const retryingRunId = randomUUID();
  await createQueuedRun(store, deployment, retryingRunId, `job-${retryingRunId}`, {
    case: "retrying-queued",
  });
  await store.createRunExecution({
    workerName: "verification",
    executionNumber: 1,
    attempt: 1,
    metadata: {},
    queueJobId: `job-${retryingRunId}`,
    runId: retryingRunId,
    startedAt,
    status: "running",
  });
  await store.completeRunExecution({
    executionNumber: 1,
    durationMs: 1000,
    finishedAt: new Date().toISOString(),
    metadata: {},
    runId: retryingRunId,
    status: "retrying",
    stderr: "",
    stdout: "",
  });
  await store.updateRunState({
    attemptsMade: 1,
    runId: retryingRunId,
    status: "queued",
  });

  const resumable = await store.listQueuedRuns({
    environment: deployment.environment,
  });
  const resumableIds = new Set(resumable.map((run) => run.runId));
  assert.equal(
    resumableIds.has(resumableRunId),
    true,
    "queued run with a suspended latest execution must be listed as resumable",
  );
  assert.equal(resumableIds.has(retryingRunId), true, "queued retry backoff must be recovered");
  assert.equal(
    resumableIds.has(freshRunId),
    true,
    "queued run without executions must also be recovered",
  );
}

it("queued run recovery query", async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-machine");
  await verifyQueuedRunRecoveryQuery(store, deployment);
});

it("due sleeping runs cutoff", async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-machine");
  await verifyDueSleepingRunsCutoff(store, deployment);
});

it("queued runs with attempts query", async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-machine");
  await verifyQueuedRunsWithAttemptsQuery(store, deployment);
});
