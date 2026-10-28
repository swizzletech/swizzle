import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ControlPlaneStore, StoredDeployment } from "@swizzle/db";
import { it } from "vitest";
import { testControlPlaneStore } from "../test/stores.js";
import { commitDeploymentFixture, createQueuedRun } from "./verify-state-fixtures.js";

async function verifyTerminalRunStateGuard(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
): Promise<void> {
  const runId = randomUUID();
  const queueJobId = `job-${runId}`;
  await createQueuedRun(store, deployment, runId, queueJobId, { case: "terminal-guard" });

  const startedAt = new Date(Date.now() - 10_000).toISOString();
  await store.createRunExecution({
    workerName: "verification",
    executionNumber: 1,
    attempt: 1,
    metadata: { verification: "state-machine" },
    queueJobId,
    runId,
    startedAt,
    status: "running",
  });
  await store.updateRunState({
    attemptsMade: 1,
    runId,
    startedAt,
    status: "running",
  });

  const cancelledAt = new Date(Date.now() - 5_000).toISOString();
  await store.updateRunState({
    attemptsMade: 1,
    deadLetterReason: "operator-canceled",
    errorCode: "CANCELLED",
    errorMessage: "cancelled by verifier",
    finishedAt: cancelledAt,
    runId,
    status: "dead-lettered",
  });

  const lateFinishedAt = new Date().toISOString();
  await store.completeRunExecution({
    executionNumber: 1,
    durationMs: 10_000,
    finishedAt: lateFinishedAt,
    metadata: { completion: "late-worker" },
    runId,
    status: "succeeded",
    stderr: "",
    stdout: '{"ok":true}',
  });
  await store.updateRunState({
    finishedAt: lateFinishedAt,
    result: { ok: true },
    runId,
    status: "succeeded",
    stderr: "late stderr should not be persisted on the run",
    stdout: '{"ok":true}',
  });

  const persisted = await store.getRun(runId);
  assert.equal(persisted?.status, "dead-lettered");
  assert.equal(persisted.deadLetterReason, "operator-canceled");
  assert.equal(persisted.result, null);
  assert.equal(persisted.stdout, "");
  assert.equal(persisted.stderr, "");
  assert.equal(persisted.executions[0]?.status, "succeeded");
}

async function verifyWaitingRunResumeGuard(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
): Promise<void> {
  const waitingRunId = randomUUID();
  await createQueuedRun(store, deployment, waitingRunId, `job-${waitingRunId}`, {
    case: "resume-guard-waiting",
  });
  await store.updateRunState({
    attemptsMade: 1,
    runId: waitingRunId,
    status: "waiting",
    wait: { stepKey: "nap", reason: "sleep", until: "2030-01-01T00:00:00.000Z" },
  });

  const resumed = await store.resumeWaitingRun({
    expectedWaitReason: "sleep",
    result: { value: { sleptUntil: "2030-01-01T00:00:00.000Z" } },
    runId: waitingRunId,
    stepKey: "nap",
  });
  assert.notEqual(resumed, null);
  assert.equal(resumed?.status, "queued");
  assert.equal(resumed.wait, null);
  assert.equal(resumed?.resumeCount, 1);

  const deadLetteredRunId = randomUUID();
  await createQueuedRun(store, deployment, deadLetteredRunId, `job-${deadLetteredRunId}`, {
    case: "resume-guard-dead-lettered",
  });
  await store.updateRunState({
    attemptsMade: 1,
    runId: deadLetteredRunId,
    status: "waiting",
    wait: { stepKey: "nap", reason: "sleep", until: "2030-01-01T00:00:00.000Z" },
  });
  await store.updateRunState({
    attemptsMade: 1,
    deadLetterReason: "operator-canceled",
    errorCode: "RUN_CANCELLED",
    errorClassification: "terminal",
    errorMessage: "cancelled by verifier",
    finishedAt: new Date().toISOString(),
    runId: deadLetteredRunId,
    status: "dead-lettered",
  });

  const notResumed = await store.resumeWaitingRun({
    expectedWaitReason: "sleep",
    result: { value: { sleptUntil: "2030-01-01T00:00:00.000Z" } },
    runId: deadLetteredRunId,
    stepKey: "nap",
  });
  assert.equal(notResumed, null);
  assert.equal((await store.getRun(deadLetteredRunId))?.status, "dead-lettered");
}

async function verifyRunStepMemoization(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
): Promise<void> {
  const runId = randomUUID();
  const queueJobId = `job-${runId}`;
  await createQueuedRun(store, deployment, runId, queueJobId, { case: "run-step-memoization" });

  await store.setRunStepResult({
    executionNumber: 1,
    runId,
    stepKey: "expensive-side-effect",
    value: { attempt: 1, ok: true },
  });

  const firstList = await store.listRunSteps({ runId });
  assert.equal(firstList.length, 1);
  assert.equal(firstList[0]?.stepKey, "expensive-side-effect");
  assert.deepEqual(firstList[0]?.value, { attempt: 1, ok: true });

  await store.setRunStepResult({
    executionNumber: 2,
    runId,
    stepKey: "expensive-side-effect",
    value: { attempt: 2, ok: true },
  });

  const afterUpsert = await store.listRunSteps({ runId });
  assert.equal(afterUpsert.length, 1);
  assert.equal(afterUpsert[0]?.executionNumber, 1);
  assert.deepEqual(afterUpsert[0]?.value, { attempt: 1, ok: true });

  // The run's totals count each row and each stored result once: a start adds a row, its result
  // adds bytes, and an ignored duplicate adds nothing.
  await store.startRunStep({
    executionNumber: 2,
    runId,
    startedAt: new Date().toISOString(),
    stepKey: "second",
  });
  await store.setRunStepResult({ executionNumber: 2, runId, stepKey: "second", value: "ok" });
  const totals = await store.getRunStepTotals({ runId, stepKey: "second" });
  assert.equal(totals.steps, 2);
  assert.equal(totals.resultBytes, '{"attempt":1,"ok":true}'.length + '"ok"'.length);
  assert.equal(totals.step?.value, "ok");

  // Concurrent results for one new key: exactly one lands, the rest see it under the run's lock.
  const raced = await Promise.allSettled(
    Array.from({ length: 8 }, (_, attempt) =>
      store.setRunStepResult({ executionNumber: 3, runId, stepKey: "raced", value: { attempt } }),
    ),
  );
  assert.deepEqual(
    raced.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason),
    [],
  );
  const racedTotals = await store.getRunStepTotals({ runId, stepKey: "raced" });
  assert.equal(racedTotals.steps, 3);
  assert.equal(
    racedTotals.resultBytes,
    totals.resultBytes + JSON.stringify(racedTotals.step?.value).length,
  );
}

it("terminal run state guard", async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-machine");
  await verifyTerminalRunStateGuard(store, deployment);
});

it("waiting run resume guard", async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-machine");
  await verifyWaitingRunResumeGuard(store, deployment);
});

it("run step memoization", async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-machine");
  await verifyRunStepMemoization(store, deployment);
});
