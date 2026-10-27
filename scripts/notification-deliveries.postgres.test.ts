import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ControlPlaneStore, StoredDeployment } from "@swizzle/db";
import type { DatabaseClient } from "@swizzle/db/postgres";
import { it } from "vitest";
import { testDatabase } from "../test/postgres.js";
import { testControlPlaneStore } from "../test/stores.js";
import { commitDeploymentFixture } from "./verify-state-fixtures.js";

// The cooldown of a notification rule reads the rule's latest delivery for one automation, in the
// rule's environment.
async function verifyLatestNotificationDeliveryForRule(
  client: DatabaseClient,
  store: ControlPlaneStore,
  deployment: StoredDeployment,
): Promise<void> {
  const { rows } = await client.pool.query<{ id: string }>(
    "INSERT INTO auth_users (name, email, role) VALUES ('Rule', 'rule@notifications.verify', 'member') RETURNING id",
  );
  const rule = await store.createNotificationRule({
    automationId: deployment.automationId,
    projectId: deployment.projectId,
    userId: rows[0]?.id ?? assert.fail("person row"),
    channel: "telegram",
    chatId: "-1001",
    cooldownSeconds: 900,
    environment: deployment.environment,
    eventType: "dead-lettered",
    threshold: 1,
    windowSeconds: 3600,
  });
  const delivery = await store.recordNotificationDelivery({
    automationId: deployment.automationId,
    channel: "telegram",
    chatId: "-1001",
    dedupeKey: `state-machine-${randomUUID()}`,
    environment: deployment.environment,
    eventType: "dead-lettered",
    ruleId: rule.ruleId,
    status: "sent",
  });

  const latest = await store.getLatestNotificationDeliveryForRule(
    rule.ruleId,
    rule.environment,
    deployment.automationId,
    "dead-lettered",
  );
  assert.equal(latest?.deliveryId, delivery.delivery.deliveryId);
}

/** The Overview counts failed deliveries of the last day; a filter the SQL drops would hide them. */
async function verifyNotificationDeliveryFilters(
  store: ControlPlaneStore,
  deployment: StoredDeployment,
): Promise<void> {
  const record = (status: "failed" | "sent") =>
    store.recordNotificationDelivery({
      automationId: deployment.automationId,
      channel: "telegram",
      chatId: "-1002",
      dedupeKey: `delivery-filter-${randomUUID()}`,
      environment: deployment.environment,
      eventType: "dead-lettered",
      status,
    });
  const failed = await record("failed");
  await record("sent");

  const failedToday = await store.listNotificationDeliveries({
    automationSlug: deployment.automationSlug,
    createdSince: new Date(Date.now() - 86_400_000).toISOString(),
    environment: deployment.environment,
    status: "failed",
  });
  assert.deepEqual(
    failedToday.map((delivery) => delivery.deliveryId),
    [failed.delivery.deliveryId],
  );
  const tomorrow = await store.listNotificationDeliveries({
    createdSince: new Date(Date.now() + 86_400_000).toISOString(),
    environment: deployment.environment,
  });
  assert.deepEqual(tomorrow, []);
}

it("latest notification delivery for rule", { timeout: 60_000 }, async () => {
  const client = testDatabase();
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-machine");
  await verifyLatestNotificationDeliveryForRule(client, store, deployment);
});

it("notification delivery filters", { timeout: 60_000 }, async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-machine");
  await verifyNotificationDeliveryFilters(store, deployment);
});
