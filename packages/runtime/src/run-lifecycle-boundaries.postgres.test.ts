import { randomUUID } from "node:crypto";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { createPostgresControlPlaneStore, createPostgresDispatchStore } from "@swizzle/db/postgres";
import { expect, it, vi } from "vitest";
import {
  commitDeploymentFixture,
  createQueuedRun,
} from "../../../scripts/verify-state-fixtures.js";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import { testControlPlaneStore } from "../../../test/stores.js";
import { createAutomationFixture } from "../test/platform-harness.js";
import {
  failPlacement,
  processRunTerminalEffects,
  reconcileQueuedRunsWithStore,
} from "./run-lifecycle.js";

it("sets the placement deadline from runtime.queue_timeout", async () => {
  const client = testDatabase();
  const platform = await testPlatform({ client });
  const dispatch = createPostgresDispatchStore({ client });
  const automationDirectory = await createAutomationFixture({
    name: "placement-deadline",
    triggerLines: ["  type: webhook", "  path: /placement-deadline"],
    configLines: ["runtime:", "  queue_timeout: 30s"],
  });
  await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });

  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { runId } = await platform.enqueuePlatformRun({
      automationName: "placement-deadline",
      environment: "local",
      payload: {},
    });
    const expirePlacements = () =>
      dispatch.expirePlacements(({ run, projectName }, store) =>
        failPlacement({ run, projectName, store }),
      );

    vi.setSystemTime(new Date("2026-01-01T00:00:29.999Z"));
    await expirePlacements();
    expect(await platform.getPlatformRun(runId)).toMatchObject({
      status: "queued",
      executions: [],
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    await expirePlacements();
    expect(await platform.getPlatformRun(runId)).toMatchObject({
      status: "dead-lettered",
      errorCode: "PLACEMENT_TIMEOUT",
      executions: [],
    });
  } finally {
    vi.useRealTimers();
    await platform.close();
  }
});

it("publishes a terminal chain child only after its transaction commits and recovers a lost job", async () => {
  const client = testDatabase();
  const store = testControlPlaneStore();
  const source = await commitDeploymentFixture(store, "commit-source");
  const child = await commitDeploymentFixture(
    store,
    "commit-child",
    DEFAULT_PROJECT_ID,
    source.environment,
    [],
    {
      type: "chain",
      source: "commit-source",
      on: "succeeded",
      payload: "result",
    },
  );
  const sourceId = randomUUID();
  await createQueuedRun(store, source, sourceId, sourceId, {});
  await store.updateRunState({ runId: sourceId, status: "succeeded", result: { committed: true } });
  await store.markRunTerminalPending(sourceId);
  const enqueue = vi.fn(async ({ runId }: { runId: string }) => {
    expect(await store.getRun(runId)).toMatchObject({
      automationId: child.automationId,
      status: "queued",
      payload: { committed: true },
    });
  });
  const queue = {
    enqueue,
    enqueueCheck: async () => {},
    hasJob: async () => false,
    close: async () => {},
  };
  const dispatch = createPostgresDispatchStore({ client });
  await dispatch.drainTerminals(async (run, transactionStore) => {
    await processRunTerminalEffects({ run, store: transactionStore });
    const pending = await transactionStore.listQueuedRuns({});
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ automationId: child.automationId });
    expect(await store.listQueuedRuns({})).toEqual([]);
    await reconcileQueuedRunsWithStore(store, queue, {});
    expect(enqueue).not.toHaveBeenCalled();
  });
  await reconcileQueuedRunsWithStore(store, queue, {});
  expect(enqueue).toHaveBeenCalledTimes(1);
  await dispatch.drainTerminals((run, transactionStore) =>
    processRunTerminalEffects({ run, store: transactionStore }),
  );
  expect(await store.listQueuedRuns({})).toHaveLength(1);
  // A lost job is republished from the committed row without another child or terminal intent.
  await reconcileQueuedRunsWithStore(store, queue, {});
  expect(enqueue).toHaveBeenCalledTimes(2);
});

it("rolls back a lifecycle child when the surrounding transaction fails", async () => {
  const client = testDatabase();
  const store = testControlPlaneStore();
  const source = await commitDeploymentFixture(store, "rollback-source");
  await commitDeploymentFixture(
    store,
    "rollback-child",
    DEFAULT_PROJECT_ID,
    source.environment,
    [],
    {
      type: "chain",
      source: "rollback-source",
      on: "succeeded",
      payload: "result",
    },
  );
  const runId = randomUUID();
  await createQueuedRun(store, source, runId, runId, {});
  await store.updateRunState({ runId, status: "succeeded" });
  const failure = new Error("injected before commit");
  await expect(
    client.db.transaction(async (tx) => {
      const scoped = createPostgresControlPlaneStore({ client: { ...client, db: tx } });
      const run = await scoped.getRun(runId);
      if (run === null) throw new Error("Missing source run");
      await processRunTerminalEffects({ run, store: scoped });
      expect(await scoped.listQueuedRuns({})).toHaveLength(1);
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await store.listQueuedRuns({})).toEqual([]);
});
