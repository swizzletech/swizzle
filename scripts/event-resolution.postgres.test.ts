import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ControlPlaneStore } from "@swizzle/db";
import { type RunQueueProducer, resolveWaitingEventRun } from "@swizzle/runtime/platform";
import { it } from "vitest";
import { testControlPlaneStore } from "../test/stores.js";
import { commitDeploymentFixture, createQueuedRun } from "./verify-state-fixtures.js";

async function verifyEventResolutionSingleShot(store: ControlPlaneStore): Promise<void> {
  const deployment = await commitDeploymentFixture(store, "state-machine-event-single-shot");
  const runId = randomUUID();
  const queueJobId = `job-${runId}`;
  const stepKey = "event-single-shot";
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const finishedAt = new Date().toISOString();
  await createQueuedRun(store, deployment, runId, queueJobId, {
    case: "event-resolution-single-shot",
  });
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
  await store.completeRunExecution({
    executionNumber: 1,
    durationMs: 1_000,
    finishedAt,
    wait: { reason: "event", stepKey },
    runId,
    status: "suspended",
    stderr: "",
    stdout: "",
  });
  await store.updateRunState({
    attemptsMade: 1,
    runId,
    status: "waiting",
    wait: {
      stepKey,
      reason: "event",
      until: null,
      startedAt: new Date().toISOString(),
      details: null,
    },
  });

  const run = await store.getRun(runId);
  if (run === null) {
    throw new Error("event-resolution fixture run was not persisted");
  }
  const queue = createNoopQueue();
  const resolved = await resolveWaitingEventRun({
    queue,
    run,
    stepKey,
    store,
    value: { ok: true },
  });
  assert.equal(resolved.status, "resolved");
  const afterResolve = await store.getRun(runId);
  assert.equal(afterResolve?.status, "queued");
  assert.equal(afterResolve.wait, null);
  if (afterResolve === null) {
    throw new Error("event-resolution fixture run disappeared after resume");
  }

  const second = await resolveWaitingEventRun({
    queue,
    run: afterResolve,
    stepKey,
    store,
    value: { ok: false },
  });
  assert.equal(second.status, "not-waiting");
  const steps = await store.listRunSteps({ runId });
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]?.value, { timedOut: false, value: { ok: true } });
}

function createNoopQueue(): RunQueueProducer {
  return {
    close: async () => {},
    enqueue: async () => {},
    enqueueCheck: async () => {},
    hasJob: async () => false,
  };
}

it("event resolution single shot", { timeout: 60_000 }, async () => {
  const store = testControlPlaneStore();
  await verifyEventResolutionSingleShot(store);
});
