import assert from "node:assert/strict";
import { type ControlPlaneStore, DEFAULT_PROJECT_ID, type StoredDeployment } from "@swizzle/db";
import {
  createDashboardStore,
  createPostgresAccessStore,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { it, vi } from "vitest";
import { testDatabase } from "../test/postgres.js";
import { testControlPlaneStore } from "../test/stores.js";
import { lockWaiters } from "./verify-postgres-locks.js";
import { commitDeploymentFixture } from "./verify-state-fixtures.js";

async function verifyDeploymentCommit(store: ControlPlaneStore): Promise<StoredDeployment> {
  const deployment = await commitDeploymentFixture(store, "state-machine-webhook");

  const activeDeployment = await store.getActiveDeploymentBySlug(
    "state-machine-webhook",
    "state-machine",
  );
  assert.equal(activeDeployment?.deploymentId, deployment.deploymentId);

  const trigger = await store.getAutomationTriggerBySlug("state-machine-webhook", "state-machine");
  assert.equal(trigger?.deploymentId, deployment.deploymentId);
  assert.equal(trigger.webhookPath, "/state-machine-webhook");

  const auditEvents = await store.listDeploymentAuditEventsByAutomationSlug(
    "state-machine-webhook",
    "state-machine",
  );
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.change.deploymentId, deployment.deploymentId);
  assert.equal(auditEvents[0]?.change.eventType, "deploy");

  return deployment;
}

/** A join's display order comes from config, even when UUID order is the reverse. */
async function verifyChainSourceOrder(
  client: DatabaseClient,
  store: ControlPlaneStore,
): Promise<void> {
  const sources = await Promise.all(
    ["order-zebra", "order-alpha", "order-middle"].map((name) =>
      commitDeploymentFixture(store, name),
    ),
  );
  const names = sources
    .sort((a, b) => b.automationId.localeCompare(a.automationId))
    .map((source) => source.automationSlug);
  await commitDeploymentFixture(store, "order-join", DEFAULT_PROJECT_ID, "state-machine", [], {
    type: "chain",
    sources: names,
    on: "all-succeeded",
    payload: "results",
  });
  const dashboard = createDashboardStore({ client });
  const detail = await dashboard.getAutomationDetail("order-join", "state-machine", { all: true });
  assert.deepEqual(detail?.trigger?.chainSourceAutomationSlugs, names);
}

/** Deploy and move protect the same project boundary, including paused join edges. */
async function verifyChainProjects(
  client: DatabaseClient,
  store: ControlPlaneStore,
): Promise<void> {
  const access = createPostgresAccessStore({ client });
  const office = await access.createProject({ slug: "chain-office", name: "Chain office" });
  const target = await access.createProject({ slug: "chain-target", name: "Chain target" });
  const first = await commitDeploymentFixture(store, "chain-first", office.id);
  const second = await commitDeploymentFixture(store, "chain-second", office.id);
  for (const source of ["chain-first", "absent"]) {
    await assert.rejects(
      commitDeploymentFixture(store, "chain-refused", target.id, "state-machine", [], {
        type: "chain",
        source,
        on: "succeeded",
        payload: "result",
      }),
      {
        code: "TRIGGER_CONFIGURATION_INVALID",
        message: `Chain source automation not found: ${source}`,
      },
    );
    assert.equal(await store.findAutomation("chain-refused"), null);
  }
  const join = await commitDeploymentFixture(
    store,
    "chain-together",
    office.id,
    "state-machine",
    [],
    {
      type: "chain",
      sources: [first.automationSlug, second.automationSlug],
      on: "all-succeeded",
      payload: "results",
    },
  );
  for (const automation of [first, second, join]) {
    await store.updateAutomationTriggerStatus({
      automationSlug: automation.automationSlug,
      environment: "state-machine",
      status: "paused",
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(
      store.moveAutomation({ automationSlug: automation.automationSlug, projectId: target.id }),
      { code: "AUTOMATION_CHAIN_CONNECTED" },
    );
    assert.equal((await store.findAutomation(automation.automationSlug))?.projectId, office.id);
  }
  const moved = await store.deleteProject({
    projectId: office.id,
    contents: { kind: "move", projectId: target.id },
  });
  assert.equal(moved.contents, "move");
  for (const automation of [first, second, join])
    assert.equal((await store.findAutomation(automation.automationSlug))?.projectId, target.id);
  assert.deepEqual(
    (
      await store.getAutomationTriggerBySlug(join.automationSlug, "state-machine")
    )?.chainSourceAutomationIds.toSorted(),
    [first.automationId, second.automationId].sort(),
  );
}

it("deployment commit", { timeout: 60_000 }, async () => {
  const store = testControlPlaneStore();
  await verifyDeploymentCommit(store);
});

it("returns the deployment-check conflict code when concurrent commits claim one webhook path", async () => {
  const store = testControlPlaneStore();
  const trigger = { type: "webhook", path: "/shared-path" } as const;
  const client = testDatabase();
  const blocker = await client.pool.connect();
  const results = await (async () => {
    try {
      await blocker.query("BEGIN");
      // Both prechecks must finish before either insert can claim the path.
      await blocker.query("LOCK TABLE automation_triggers IN SHARE MODE");
      const pending = Promise.allSettled(
        ["path-first", "path-second"].map((name) =>
          commitDeploymentFixture(store, name, DEFAULT_PROJECT_ID, "state-machine", [], trigger),
        ),
      );
      try {
        await vi.waitFor(async () => assert.equal(await lockWaiters(client), 2), {
          timeout: 10_000,
        });
      } finally {
        await blocker.query("ROLLBACK");
        await pending;
      }
      return await pending;
    } finally {
      blocker.release();
    }
  })();
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const refused = results.find((result) => result.status === "rejected");
  assert.equal(refused?.reason.code, "TRIGGER_WEBHOOK_PATH_CONFLICT", String(refused?.reason));
  await assert.rejects(
    commitDeploymentFixture(store, "path-third", DEFAULT_PROJECT_ID, "state-machine", [], trigger),
    { code: "TRIGGER_WEBHOOK_PATH_CONFLICT" },
  );
  const winner = results.find((result) => result.status === "fulfilled");
  assert.equal(
    (await store.getWebhookTriggerByPath("/shared-path", "state-machine"))?.automationId,
    winner?.value.automationId,
  );
});

it("chain source order", { timeout: 60_000 }, async () => {
  const client = testDatabase();
  const store = testControlPlaneStore();
  await verifyChainSourceOrder(client, store);
});

it("chain projects", { timeout: 60_000 }, async () => {
  const client = testDatabase();
  const store = testControlPlaneStore();
  await verifyChainProjects(client, store);
});
