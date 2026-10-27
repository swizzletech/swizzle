import path from "node:path";

import { DEFAULT_PROJECT_ID } from "@swizzle/db";

import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { testDatabase } from "../../../test/postgres.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

import { createAutomationFixture, packageRoot } from "../test/platform-harness.js";

import { deliverPendingNotification, processRunNotifications } from "./notifications.js";

// Run execution: retries, durable steps, child invokes, cancellation and failure alerts.

const READER = "00000000-0000-4000-8000-0000000000aa";

async function seedReader() {
  await testDatabase().pool.query(
    "INSERT INTO auth_users (id, name, email, role) VALUES ($1, 'Reader', 'reader@example.test', 'owner') ON CONFLICT DO NOTHING",
    [READER],
  );
}

/** Where a rule of READER points: one automation, or with null every one of the default project. */
async function ruleTarget(
  platform: Awaited<ReturnType<typeof testPlatform>>,
  automationName: string | null,
) {
  await seedReader();
  const automation = automationName === null ? null : await platform.findAutomation(automationName);
  return {
    automationId: automation?.automationId ?? null,
    projectId: DEFAULT_PROJECT_ID,
    userId: READER,
  };
}

describe("platform notifications", () => {
  it("sends exactly one dead-letter notification through Telegram when credentials exist", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const telegramFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(packageRoot, "test-fixtures/invalid-json-output"),
    });
    await platform.upsertSecret("SWIZZLE_TELEGRAM_BOT_TOKEN", "telegram-token", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    await platform.createNotificationRule({
      ...(await ruleTarget(platform, "invalid-json-output")),
      environment: "local",
      chatId: "-1001234567890",
      eventType: "dead-lettered",
    });

    const queuedRun = await platform.startManualRun({
      environment: "local",
      automationName: "invalid-json-output",
      payload: { source: "dead-letter" },
    });

    const processedRun = await platform.processNextPlatformRun();
    expect(processedRun?.status).toBe("dead-lettered");
    expect(telegramFetch).toHaveBeenCalledTimes(1);

    const deliveries = await platform.listNotificationDeliveries({ environment: "local" });
    expect(deliveries).toEqual([
      expect.objectContaining({
        eventType: "dead-lettered",
        runId: queuedRun.runId,
        status: "sent",
      }),
    ]);
  });

  it("lets a rule without an automation alert each automation, with its own cooldown", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const telegramFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", telegramFetch);
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    for (const name of ["crash-a", "crash-b"]) {
      await platform.deployAutomationToPlatform({
        automationDirectory: await createAutomationFixture({
          configLines: ["runtime:", "  retry:", "    max_attempts: 1"],
          mainJs: "process.exit(1);\n",
          name,
          triggerLines: ["  type: webhook", `  path: /${name}`],
        }),
        environment: "local",
      });
    }
    await platform.upsertSecret("SWIZZLE_TELEGRAM_BOT_TOKEN", "telegram-token", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    const rule = await platform.createNotificationRule({
      ...(await ruleTarget(platform, null)),
      chatId: "-1001234567890",
      environment: "local",
      eventType: "dead-lettered",
    });
    expect(rule.automationSlug).toBeNull();

    for (const automationName of ["crash-a", "crash-b", "crash-a"]) {
      await platform.startManualRun({
        automationName,
        environment: "local",
        payload: {},
      });
      await platform.processNextPlatformRun();
    }

    const deliveries = await platform.listNotificationDeliveries({ environment: "local" });
    expect(
      deliveries.map((delivery) => `${delivery.automationSlug} ${delivery.status}`).toSorted(),
    ).toEqual(["crash-a sent", "crash-a skipped", "crash-b sent"]);
    expect(telegramFetch).toHaveBeenCalledTimes(2);
  });

  it("stops a person's alerts once they may no longer read the automation", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const telegramFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", telegramFetch);
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    await platform.deployAutomationToPlatform({
      automationDirectory: await createAutomationFixture({
        configLines: ["runtime:", "  retry:", "    max_attempts: 1"],
        mainJs: "process.exit(1);\n",
        name: "crash",
        triggerLines: ["  type: webhook", "  path: /crash"],
      }),
      environment: "local",
    });
    await platform.upsertSecret("SWIZZLE_TELEGRAM_BOT_TOKEN", "telegram-token", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    await platform.createNotificationRule({
      ...(await ruleTarget(platform, null)),
      chatId: "-1001234567890",
      environment: "local",
      eventType: "dead-lettered",
    });

    const crash = async () => {
      await platform.startManualRun({
        automationName: "crash",
        environment: "local",
        payload: {},
      });
      await platform.processNextPlatformRun();
    };
    await crash();
    await testDatabase().pool.query("UPDATE auth_users SET suspended_at = now() WHERE id = $1", [
      READER,
    ]);
    // Inside the rule's cooldown: the record names the revoked access, not the cooldown.
    await crash();

    const deliveries = await platform.listNotificationDeliveries({ environment: "local" });
    expect(
      deliveries
        .map((delivery) => `${delivery.status} ${String(delivery.metadata.reason ?? "")}`.trim())
        .toSorted(),
    ).toEqual(["sent", "skipped access-revoked"]);
    expect(telegramFetch).toHaveBeenCalledTimes(1);
  });

  it("rechecks revoked access after a notification intent commits", async () => {
    const platform = await testPlatform({
      artifactsDirectory: path.join(
        await temporaryDirectory("swizzle-pending-alert-"),
        "artifacts",
      ),
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(packageRoot, "test-fixtures/invalid-json-output"),
    });
    const queued = await platform.startManualRun({
      environment: "local",
      automationName: "invalid-json-output",
      payload: {},
    });
    await platform.processNextPlatformRun();
    await platform.createNotificationRule({
      ...(await ruleTarget(platform, "invalid-json-output")),
      chatId: "pending",
      environment: "local",
      eventType: "dead-lettered",
    });
    const sender = vi.fn(async () => ({ providerMessageId: "unexpected" }));
    const [intent] = await processRunNotifications({
      run: await platform.getPlatformRun(queued.runId),
      store: platform.store,
    });
    expect(intent?.status).toBe("pending");
    if (intent === undefined) throw new Error("Expected a durable intent");
    await testDatabase().pool.query("UPDATE auth_users SET suspended_at = now() WHERE id = $1", [
      READER,
    ]);
    expect(await deliverPendingNotification(intent, platform.store, sender)).toMatchObject({
      status: "skipped",
      metadata: { reason: "access-revoked" },
    });
    expect(sender).not.toHaveBeenCalled();
    await platform.close();
  });

  it("leaves no delivery behind when the access check fails, so the next attempt sends", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const telegramFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", telegramFetch);
    let away = false;
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    await platform.deployAutomationToPlatform({
      automationDirectory: await createAutomationFixture({
        configLines: ["runtime:", "  retry:", "    max_attempts: 1"],
        mainJs: "process.exit(1);\n",
        name: "crash",
        triggerLines: ["  type: webhook", "  path: /crash"],
      }),
      environment: "local",
    });
    await platform.upsertSecret("SWIZZLE_TELEGRAM_BOT_TOKEN", "telegram-token", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    const { runId } = await platform.startManualRun({
      automationName: "crash",
      environment: "local",
      payload: {},
    });
    const run = await platform.processNextPlatformRun();
    expect(run?.status).toBe("dead-lettered");
    await platform.createNotificationRule({
      ...(await ruleTarget(platform, null)),
      chatId: "-1001234567890",
      environment: "local",
      eventType: "dead-lettered",
    });

    const store = platform.store;
    const mayRead = store.personMayRead;
    vi.spyOn(store, "personMayRead").mockImplementation(async (...args) => {
      if (away) throw new Error("the database is away");
      return mayRead(...args);
    });
    away = true;
    const dead = await platform.getPlatformRun(runId);
    await expect(processRunNotifications({ run: dead, store })).rejects.toThrow("away");
    expect(await platform.listNotificationDeliveries({ environment: "local" })).toEqual([]);
    away = false;
    const [intent] = await processRunNotifications({ run: dead, store });
    if (intent === undefined) throw new Error("Expected a durable intent");
    await deliverPendingNotification(intent, store);
    expect(
      (await platform.listNotificationDeliveries({ environment: "local" })).map(
        (delivery) => delivery.status,
      ),
    ).toEqual(["sent"]);
    expect(telegramFetch).toHaveBeenCalledTimes(1);
  });

  it("waits for the repeated-failure threshold before sending alerts", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const telegramFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(packageRoot, "test-fixtures/invalid-json-output"),
    });
    await platform.upsertSecret("SWIZZLE_TELEGRAM_BOT_TOKEN", "telegram-token", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    await platform.createNotificationRule({
      ...(await ruleTarget(platform, "invalid-json-output")),
      environment: "local",
      chatId: "-1001234567890",
      eventType: "repeated-failures",
      threshold: 2,
      windowSeconds: 3600,
    });

    await platform.startManualRun({
      environment: "local",
      automationName: "invalid-json-output",
      payload: { source: "first-failure" },
    });
    await platform.processNextPlatformRun();

    expect(telegramFetch).toHaveBeenCalledTimes(0);

    await platform.startManualRun({
      environment: "local",
      automationName: "invalid-json-output",
      payload: { source: "second-failure" },
    });
    await platform.processNextPlatformRun();

    expect(telegramFetch).toHaveBeenCalledTimes(1);

    const deliveries = await platform.listNotificationDeliveries({ environment: "local" });
    expect(deliveries[0]).toMatchObject({
      eventType: "repeated-failures",
      status: "sent",
    });
  });
});
