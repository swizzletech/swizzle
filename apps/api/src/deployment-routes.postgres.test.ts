import { writeFile } from "node:fs/promises";

import path from "node:path";

import { fileURLToPath } from "node:url";
import { createDashboardStore, createPostgresWorkerRegistry } from "@swizzle/db/postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";

import { testDatabase } from "../../../test/postgres.js";

import { testFolderStore } from "../../../test/stores.js";

import { temporaryDirectory } from "../../../test/support.js";

import { createAutomationFixture, deployFixture } from "../test/automations.js";

import { ownerHeaders } from "../test/people.js";

import { buildTestServer } from "../test/server-harness.js";
import { createDashboardDataProvider } from "./dashboard.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

const appRoot = path.resolve(sourceRoot, "..");

const repoRoot = path.resolve(appRoot, "../..");

let owner: { readonly authorization: string };

beforeEach(async () => {
  owner = await ownerHeaders();
});

describe("deployment routes", () => {
  it("deploys an automation, triggers it via config path, and exposes durable run inspection", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });

    const deployResponse = await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );

    expect(deployResponse.statusCode).toBe(200);
    expect(deployResponse.json()).toMatchObject({
      automationName: "hello-webhook",
      triggerType: "webhook",
      version: "1.0.0",
    });

    const triggerStateResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/hello-webhook/trigger",
    });
    expect(triggerStateResponse.statusCode).toBe(200);
    expect(triggerStateResponse.json()).toMatchObject({
      status: "active",
      webhookPath: "/hooks/hello",
    });

    const triggerResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: { source: "api-test" },
      url: "/hooks/hello",
    });

    expect(triggerResponse.statusCode).toBe(200);
    const triggerBody = triggerResponse.json();
    expect(triggerBody).toMatchObject({
      status: "queued",
    });

    const processedRun = await platform.processNextPlatformRun();
    expect(processedRun?.status).toBe("succeeded");

    const runResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: `/runs/${triggerBody.runId}`,
    });

    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json()).toMatchObject({
      executions: [
        {
          executionNumber: 1,
          status: "succeeded",
        },
      ],
      result: {
        message: "Hello from Swizzle",
        payload: { source: "api-test" },
      },
      runId: triggerBody.runId,
      status: "succeeded",
    });

    const auditResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/hello-webhook/trigger/audit",
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json()).toEqual([]);

    await app.close();
  });

  it("refuses an upload whose content hash differs before it replaces the active deployment", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");
    const app = await buildTestServer({
      platform: await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      }),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: "console.log('{\"version\":1}');",
      name: "hash-checked",
      path: "/hash-checked",
    });
    expect((await deployFixture(app, automationDirectory, {}, { headers: owner })).statusCode).toBe(
      200,
    );
    await writeFile(path.join(automationDirectory, "main.js"), "console.log('{\"version\":2}');");

    const mismatched = await deployFixture(
      app,
      automationDirectory,
      {
        expectedContentHash: "0".repeat(64),
      },
      { headers: owner },
    );

    expect(mismatched.statusCode).toBe(422);
    expect(mismatched.json()).toMatchObject({ error: "DEPLOYMENT_CONTENT_HASH_MISMATCH" });
    const history = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/hash-checked/deployments",
    });
    expect(history.json().deployments).toEqual([expect.objectContaining({ seq: 1 })]);

    await app.close();
  });

  it("manages workspace folders and assigns automations", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");
    const automationFolderStore = await testFolderStore();
    const app = await buildTestServer({
      automationFolderStore,
      platform: await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      }),
    });
    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );

    const created = await app.inject({
      headers: owner,
      method: "POST",
      payload: { name: "  Finance   ops " },
      url: "/automation-folders",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Finance ops", sortOrder: 0 });
    const folderId = created.json().id as string;

    const duplicate = await app.inject({
      headers: owner,
      method: "POST",
      payload: { name: "finance OPS" },
      url: "/automation-folders",
    });
    expect(duplicate.statusCode).toBe(409);

    const assigned = await app.inject({
      headers: owner,
      method: "PUT",
      payload: { folderId },
      url: "/automations/hello-webhook/folder",
    });
    expect(assigned.statusCode).toBe(200);
    expect(
      (
        await testDatabase().pool.query(
          "SELECT folder_id FROM automations WHERE slug = 'hello-webhook'",
        )
      ).rows[0]?.folder_id,
    ).toBe(folderId);

    const invalidAssignment = await app.inject({
      headers: owner,
      method: "PUT",
      payload: { folderId: "not-a-uuid" },
      url: "/automations/hello-webhook/folder",
    });
    expect(invalidAssignment.statusCode).toBe(400);

    const renamed = await app.inject({
      headers: owner,
      method: "PATCH",
      payload: { name: "Accounting" },
      url: `/automation-folders/${folderId}`,
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: folderId, name: "Accounting" });

    const deleted = await app.inject({
      headers: owner,
      method: "DELETE",
      url: `/automation-folders/${folderId}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (
        await testDatabase().pool.query(
          "SELECT folder_id FROM automations WHERE slug = 'hello-webhook'",
        )
      ).rows[0]?.folder_id,
    ).toBeNull();

    await app.close();
  });

  it("supports deployment history listing and rollback through the API", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });

    const deploy1 = await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );
    const firstDeploymentId = deploy1.json().deploymentId as string;

    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      { force: true },
      { headers: owner },
    );

    const historyResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/hello-webhook/deployments",
    });
    expect(historyResponse.statusCode).toBe(200);
    const historyBody = historyResponse.json();
    expect(historyBody.deployments.length).toBe(2);
    expect(historyBody.deployments.map((deployment: { seq: number }) => deployment.seq)).toEqual([
      2, 1,
    ]);
    expect(
      historyBody.deployments.filter((d: { status: string }) => d.status === "active"),
    ).toHaveLength(1);

    const rollbackResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: { targetDeploymentId: firstDeploymentId },
      url: "/automations/hello-webhook/rollback",
    });
    expect(rollbackResponse.statusCode).toBe(200);
    expect(rollbackResponse.json()).toMatchObject({
      automationName: "hello-webhook",
      seq: 3,
      sourceHash: expect.any(String),
      version: "1.0.0",
    });

    const triggerAfter = await app.inject({
      headers: owner,
      method: "POST",
      payload: { source: "post-rollback" },
      url: "/hooks/hello",
    });
    expect(triggerAfter.statusCode).toBe(200);

    await platform.processNextPlatformRun();

    const auditResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/hello-webhook/deployments/audit",
    });
    expect(auditResponse.statusCode).toBe(200);
    const audit = auditResponse.json();
    expect(audit.map((e: { change: { eventType: string } }) => e.change.eventType)).toContain(
      "rollback",
    );

    const badRollbackResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: { targetDeploymentId: "00000000-0000-4000-8000-000000000000" },
      url: "/automations/hello-webhook/rollback",
    });
    expect(badRollbackResponse.statusCode).toBe(404);
    expect(badRollbackResponse.json()).toMatchObject({
      error: "DEPLOYMENT_NOT_FOUND",
    });

    const unknownNumberResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: { targetDeploymentId: "#99" },
      url: "/automations/hello-webhook/rollback",
    });
    expect(unknownNumberResponse.statusCode).toBe(404);
    expect(unknownNumberResponse.json()).toMatchObject({
      error: "DEPLOYMENT_NOT_FOUND",
      message: "Deployment #99 not found for hello-webhook.",
    });

    const missingTargetResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: {},
      url: "/automations/hello-webhook/rollback",
    });
    expect(missingTargetResponse.statusCode).toBe(400);

    await app.close();
  });

  // The dashboard's deployment list reads readiness on every deployment, not only the active one.
  it("answers the dashboard each deployment with its readiness", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({
      dashboard: createDashboardDataProvider({
        dashboardStore: createDashboardStore({ client: testDatabase() }),
        platform,
        workerRegistry: createPostgresWorkerRegistry({ client: testDatabase() }),
      }),
      platform,
    });
    const example = path.join(repoRoot, "infra/examples/hello-webhook");
    await deployFixture(app, example, {}, { headers: owner });
    await deployFixture(app, example, { force: true }, { headers: owner });

    const detail = await app.inject({
      headers: owner,
      method: "GET",
      url: "/dashboard/automations/hello-webhook?environment=local",
    });

    expect(detail.statusCode).toBe(200);
    const ready = {
      errors: [],
      executionMode: "host",
      profile: "host-default",
      queueName: "platform-runs--host-default",
      status: "ready",
      warnings: [],
    };
    expect(detail.json()).toMatchObject({
      activeDeployment: { seq: 2, readiness: ready },
      deploymentHistory: [
        { seq: 2, readiness: ready },
        { seq: 1, readiness: ready },
      ],
    });
    await app.close();
  });

  // Behind the dashboard's proxy the API answers under /api, so the URL a sender needs keeps
  // the path of SWIZZLE_PUBLIC_URL. Without it, only a loopback Host names the address.
  it("names a webhook's URL with the path of SWIZZLE_PUBLIC_URL and never from a foreign Host", async () => {
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-api-"), "artifacts"),
    });
    const app = await buildTestServer({
      dashboard: createDashboardDataProvider({
        dashboardStore: createDashboardStore({ client: testDatabase() }),
        platform,
        workerRegistry: createPostgresWorkerRegistry({ client: testDatabase() }),
      }),
      platform,
    });
    const example = path.join(repoRoot, "infra/examples/hello-webhook");
    const detail = async (host: string) =>
      (
        await app.inject({
          headers: { ...owner, host },
          method: "GET",
          url: "/dashboard/automations/hello-webhook?environment=local",
        })
      ).json().trigger.webhookUrl;

    vi.stubEnv("SWIZZLE_PUBLIC_URL", "https://swizzle.example.com/api/");
    const applied = await deployFixture(app, example, {}, { headers: owner });
    expect(applied.json().webhookUrl).toBe(
      "https://swizzle.example.com/api/hooks/hello?environment=local",
    );
    expect(await detail("attacker.example")).toBe(
      "https://swizzle.example.com/api/hooks/hello?environment=local",
    );

    vi.stubEnv("SWIZZLE_PUBLIC_URL", "");
    expect(await detail("127.0.0.1:19826")).toBe(
      "http://127.0.0.1:19826/hooks/hello?environment=local",
    );
    expect(await detail("attacker.example")).toBeNull();
    await app.close();
  });

  it("advertises a deliverable API URL for a root webhook when the public listener only serves hooks", async () => {
    const platform = await testPlatform();
    const app = await buildTestServer({
      dashboard: createDashboardDataProvider({
        dashboardStore: createDashboardStore({ client: testDatabase() }),
        platform,
        workerRegistry: createPostgresWorkerRegistry({ client: testDatabase() }),
      }),
      platform,
    });
    const privateBase = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.stubEnv("SWIZZLE_API_ORIGIN", `${privateBase}/`);
    vi.stubEnv("SWIZZLE_PUBLIC_URL", "https://hooks.example.test/");
    try {
      const root = await createAutomationFixture({
        name: "legacy-orders",
        path: "/orders",
        mainJs: "console.log('{}');",
      });
      const applied = await deployFixture(app, root, {}, { headers: owner });
      expect(applied.statusCode).toBe(200);
      expect(applied.json().webhookUrl).toBe(`${privateBase}/orders?environment=local`);
      const detail = await app.inject({
        method: "GET",
        headers: owner,
        url: "/dashboard/automations/legacy-orders?environment=local",
      });
      expect(detail.json().trigger.webhookUrl).toBe(`${privateBase}/orders?environment=local`);
      const delivery = await fetch(applied.json().webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"order":42}',
      });
      expect(delivery.status).toBe(200);
      const queued = (await delivery.json()) as { runId: string };
      const run = await platform.getPlatformRun(queued.runId);
      expect(run.payload).toEqual({ order: 42 });
      expect(run.automationSlug).toBe("legacy-orders");
      const publicHook = await deployFixture(
        app,
        path.join(repoRoot, "infra/examples/hello-webhook"),
        {},
        { headers: owner },
      );
      expect(publicHook.json().webhookUrl).toBe(
        "https://hooks.example.test/hooks/hello?environment=local",
      );
    } finally {
      await app.close();
    }
  });

  it("supports deleting a paused automation through the API", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });

    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );

    const activeDeleteResponse = await app.inject({
      headers: owner,
      method: "DELETE",
      url: "/automations/hello-webhook",
    });
    expect(activeDeleteResponse.statusCode).toBe(409);
    expect(activeDeleteResponse.json()).toMatchObject({ error: "AUTOMATION_NOT_PAUSED" });

    await app.inject({
      headers: owner,
      method: "POST",
      url: "/automations/hello-webhook/trigger/pause",
    });

    const deleteResponse = await app.inject({
      headers: owner,
      method: "DELETE",
      url: "/automations/hello-webhook",
    });
    expect(deleteResponse.statusCode).toBe(200);
    const body = deleteResponse.json();
    expect(body.automationSlug).toBe("hello-webhook");
    expect(body.artifactsRemoved).toBe(true);
    expect(body.deletedCounts.deployments).toBeGreaterThanOrEqual(1);

    const deleteAgainResponse = await app.inject({
      headers: owner,
      method: "DELETE",
      url: "/automations/hello-webhook",
    });
    expect(deleteAgainResponse.statusCode).toBe(404);
    expect(deleteAgainResponse.json()).toMatchObject({ error: "AUTOMATION_NOT_FOUND" });

    await app.close();
  });
});
