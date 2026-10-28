import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AutomationConfig } from "@swizzle/config";
import { type ControlPlaneStore, DEFAULT_PROJECT_ID, type StoredDeployment } from "@swizzle/db";
import { it } from "vitest";
import { testControlPlaneStore } from "../test/stores.js";
import {
  commitDeploymentFixture,
  createBuildSnapshot,
  createConfig,
  createQueuedRun,
} from "./verify-state-fixtures.js";

async function verifyParentChildRunRetention(store: ControlPlaneStore): Promise<void> {
  const parentDeployment = await commitDeploymentFixture(store, "state-machine-parent-retention");
  const childDeployment = await commitDeploymentFixture(store, "state-machine-child-retention");
  const parentRunId = randomUUID();
  const childRunId = randomUUID();

  await createQueuedRun(store, parentDeployment, parentRunId, `job-${parentRunId}`, {
    case: "parent",
  });
  await createQueuedRun(
    store,
    childDeployment,
    childRunId,
    `job-${childRunId}`,
    { case: "child" },
    {
      invokeDepth: 1,
      parentRunId,
      parentStepKey: "invoke-child",
      triggerType: "chain",
    },
  );

  const children = await store.listChildRuns({ parentRunId });
  assert.equal(children.length, 1);
  assert.equal(children[0]?.runId, childRunId);
  assert.equal(children[0]?.parentStepKey, "invoke-child");

  // Deleting the parent's automation deletes its runs; the child run of another automation stays
  // and loses its parent link.
  await store.updateAutomationTriggerStatus({
    automationSlug: parentDeployment.automationSlug,
    environment: parentDeployment.environment,
    status: "paused",
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(
    store.deleteAutomation({
      automationSlug: parentDeployment.automationSlug,
      environment: parentDeployment.environment,
    }),
    (error: Error & { code?: string }) => error.code === "AUTOMATION_RUNS_ACTIVE",
  );
  for (const runId of [parentRunId, childRunId]) {
    await store.updateRunState({
      attemptsMade: 1,
      finishedAt: new Date().toISOString(),
      runId,
      status: "succeeded",
    });
  }
  const parentDelete = await store.deleteAutomation({
    automationSlug: parentDeployment.automationSlug,
    environment: parentDeployment.environment,
  });
  assert.equal(parentDelete.deletedCounts.runs, 1);
  assert.equal(await store.getRun(parentRunId), null);
  const survivingChild = await store.getRun(childRunId);
  assert.equal(survivingChild?.parentRunId, null);
  assert.equal(survivingChild?.parentStepKey, "invoke-child");
}

async function verifyChainJoinRaceArbiter(store: ControlPlaneStore): Promise<void> {
  const originDeployment = await commitDeploymentFixture(store, "state-machine-join-origin");
  const reviewerDeployment = await commitDeploymentFixture(store, "state-machine-join-reviewer");
  const verifierDeployment = await commitDeploymentFixture(store, "state-machine-join-verifier");
  const joinerConfig: AutomationConfig = {
    ...createConfig("state-machine-joiner", "1.0.0"),
    trigger: {
      on: "all-succeeded",
      payload: "results",
      sources: ["state-machine-join-reviewer", "state-machine-join-verifier"],
      type: "chain",
    },
  };
  const deployedAt = new Date().toISOString();
  const joinerCommit = await store.commitDeployment({
    intent: "deploy",
    auditEvent: {
      eventType: "deploy",
      metadata: { verification: "chain-join-race" },
    },
    credentials: [],
    deployment: {
      projectId: DEFAULT_PROJECT_ID,
      artifactBackend: "local",
      artifactLocator: {
        artifactsDirectory: "/tmp/swizzle-state-machine-artifacts",
        relativeRootPath: "state-machine-joiner/1.0.0/source",
        type: "local",
      },
      artifactRootPath: "/tmp/swizzle-state-machine-artifacts/state-machine-joiner/1.0.0",
      automationName: "state-machine-joiner",
      automationSlug: "state-machine-joiner",
      buildSnapshot: createBuildSnapshot(deployedAt),
      config: joinerConfig,
      deployedAt,
      deploymentId: randomUUID(),
      environment: "state-machine",
      entrypoint: "main.js",
      manifestPath:
        "/tmp/swizzle-state-machine-artifacts/state-machine-joiner/1.0.0/deployment.json",
      runtimeSnapshot: joinerConfig.runtime,
      sourceDirectory: "/tmp/swizzle-state-machine-source/state-machine-joiner",
      sourceHash: `state-machine-joiner-${randomUUID()}`,
    },
  });
  const joinTrigger = joinerCommit.trigger;
  assert.notEqual(joinTrigger, null);
  assert.equal(joinTrigger?.chainSourceAutomationIds.length, 2);

  const originRunId = randomUUID();
  await createQueuedRun(store, originDeployment, originRunId, `job-${originRunId}`, {
    case: "origin",
  });
  await createSucceededSourceRun(store, reviewerDeployment, originRunId, { reviewer: true });
  await createSucceededSourceRun(store, verifierDeployment, originRunId, { verifier: true });

  const sourceRuns = await store.findSucceededChainSourceRuns({
    chainOriginRunId: originRunId,
    environment: "state-machine",
    sourceAutomationIds: joinTrigger?.chainSourceAutomationIds ?? [],
  });
  assert.equal(sourceRuns.length, 2);
  const sourceRunIds = sourceRuns.map((run) => run.runId);

  const firstJoinRunId = randomUUID();
  const secondJoinRunId = randomUUID();
  const [first, second] = await Promise.all([
    store.createChainJoinRun({
      attemptsMax: 1,
      automationId: joinerCommit.deployment.automationId,
      deploymentId: joinerCommit.deployment.deploymentId,
      originRunId,
      payload: { race: 1 },
      queueJobId: firstJoinRunId,
      queueName: "platform-runs:state-machine",
      runId: firstJoinRunId,
      sourceRunIds,
      triggerId: joinTrigger?.triggerId ?? "",
      triggerType: "chain",
      versionId: joinerCommit.deployment.versionId,
    }),
    store.createChainJoinRun({
      attemptsMax: 1,
      automationId: joinerCommit.deployment.automationId,
      deploymentId: joinerCommit.deployment.deploymentId,
      originRunId,
      payload: { race: 2 },
      queueJobId: secondJoinRunId,
      queueName: "platform-runs:state-machine",
      runId: secondJoinRunId,
      sourceRunIds,
      triggerId: joinTrigger?.triggerId ?? "",
      triggerType: "chain",
      versionId: joinerCommit.deployment.versionId,
    }),
  ]);

  const createdRuns = [first, second].filter((run) => run !== null);
  assert.equal(createdRuns.length, 1, "chain join unique constraint must allow one run");
  assert.equal(createdRuns[0]?.chainOriginRunId, originRunId);
  assert.deepEqual(
    (await store.getRun(createdRuns[0]?.runId ?? ""))?.chainSourceRunIds,
    sourceRunIds,
  );
  assert.equal((await store.getRun(firstJoinRunId)) !== null, first !== null);
  assert.equal((await store.getRun(secondJoinRunId)) !== null, second !== null);
}

async function createSucceededSourceRun(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
  originRunId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const runId = randomUUID();
  await createQueuedRun(
    store,
    deployment,
    runId,
    `job-${runId}`,
    { source: deployment.automationName },
    {
      chainOriginRunId: originRunId,
      chainSourceRunIds: [originRunId],
      triggerType: "chain",
    },
  );
  await store.updateRunState({
    attemptsMade: 1,
    finishedAt: new Date().toISOString(),
    result,
    runId,
    status: "succeeded",
  });
}

it("parent child run retention", async () => {
  const store = testControlPlaneStore();
  await verifyParentChildRunRetention(store);
});

it("chain join race arbiter", async () => {
  const store = testControlPlaneStore();
  await verifyChainJoinRaceArbiter(store);
});
