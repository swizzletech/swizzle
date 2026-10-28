import { access, rm, writeFile } from "node:fs/promises";

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { temporaryDirectory } from "../../../test/support.js";

import { createAutomationFixture, packageRoot, repoRoot } from "../test/platform-harness.js";

describe("platform deployments", () => {
  it.each(["2.0.0", "3.0.0"])(
    "reports changes against the deployment committed during the build (%s)",
    async (competingVersion) => {
      const platform = await testPlatform();
      const directory = await createAutomationFixture({
        name: "commit-baseline",
        triggerLines: ["  type: webhook", "  path: /commit-baseline"],
      });
      const configPath = path.join(directory, "config.yaml");
      const config = (version: string) =>
        `name: commit-baseline\nversion: ${version}\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /commit-baseline\n`;
      await writeFile(configPath, config("1.0.0"));
      await platform.deployAutomationToPlatform({
        automationDirectory: directory,
        environment: "local",
      });
      await writeFile(configPath, config("2.0.0"));
      const competitor = await createAutomationFixture({
        name: "commit-baseline",
        triggerLines: ["  type: webhook", "  path: /commit-baseline"],
      });
      await writeFile(path.join(competitor, "config.yaml"), config(competingVersion));
      const commit = platform.store.commitDeployment.bind(platform.store);
      vi.spyOn(platform.store, "commitDeployment").mockImplementationOnce(async (input) => {
        await platform.deployAutomationToPlatform({
          automationDirectory: competitor,
          environment: "local",
        });
        return await commit(input);
      });

      const applied = await platform.deployAutomationToPlatform({
        automationDirectory: directory,
        environment: "local",
      });

      if (competingVersion === "2.0.0") {
        expect(applied).toMatchObject({ action: "noop", seq: 2, changes: [] });
      } else {
        expect(applied).toMatchObject({ action: "update", seq: 3 });
        expect(applied.changes).toEqual([{ field: "version", from: "3.0.0", to: "2.0.0" }]);
      }
    },
  );

  it("reports runtime changes beside a version change and trigger changes beside source edits", async () => {
    const platform = await testPlatform();
    const directory = await createAutomationFixture({
      name: "combined-changes",
      triggerLines: ["  type: webhook", "  path: /combined-changes"],
    });
    const configPath = path.join(directory, "config.yaml");
    await writeFile(
      configPath,
      "name: combined-changes\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /combined-changes\n",
    );
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
    await writeFile(
      configPath,
      "name: combined-changes\nversion: 2.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /combined-changes\nruntime:\n  profile: another-group\n",
    );
    const options = {
      automationDirectory: directory,
      environment: "local",
      skipReadinessCheck: true,
    };
    const preview = await platform.checkDeployment(options);
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        { field: "version", from: "1.0.0", to: "2.0.0" },
        {
          field: "config",
          from: expect.objectContaining({
            runtime: expect.objectContaining({ profile: "host-default" }),
          }),
          to: expect.objectContaining({
            runtime: expect.objectContaining({ profile: "another-group" }),
          }),
        },
      ]),
    );
    expect((await platform.deployAutomationToPlatform(options)).changes).toEqual(preview.changes);
    await writeFile(path.join(directory, "main.js"), 'console.log("{}");\n');
    await writeFile(
      configPath,
      "name: combined-changes\nversion: 2.0.0\nentrypoint: main.js\ntrigger:\n  type: cron\n  schedule: '0 * * * *'\nruntime:\n  profile: another-group\n",
    );
    const changedTrigger = await platform.checkDeployment(options);
    expect(changedTrigger.changes).toEqual(
      expect.arrayContaining([
        { field: "sourceHash", from: expect.any(String), to: expect.any(String) },
        { field: "trigger.type", from: "webhook", to: "cron" },
        { field: "trigger.path", from: "/combined-changes", to: null },
        {
          field: "config",
          from: expect.objectContaining({ trigger: expect.objectContaining({ type: "webhook" }) }),
          to: expect.objectContaining({
            trigger: expect.objectContaining({ schedule: "0 * * * *" }),
          }),
        },
      ]),
    );
  });

  it("rejects a webhook deployment without a path before creating deployment state or artifacts", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const artifactsDirectory = path.join(stateDirectory, "artifacts");
    const platform = await testPlatform({ artifactsDirectory });
    const automationDirectory = await createAutomationFixture({
      name: "missing-webhook-path",
      triggerLines: ["  type: webhook"],
    });

    await expect(
      platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory,
        skipReadinessCheck: true,
      }),
    ).rejects.toMatchObject({
      code: "TRIGGER_CONFIGURATION_INVALID",
      message: "Webhook triggers require trigger.path in config.yaml.",
    });
    expect(await platform.listAutomationDeployments("missing-webhook-path", "local")).toEqual([]);
    await expect(access(artifactsDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(
      path.join(automationDirectory, "config.yaml"),
      "name: missing-webhook-path\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /now-configured\n",
    );
    const deployment = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
    });
    expect(deployment).toMatchObject({ action: "create", seq: 1 });
    expect(await platform.getAutomationTrigger("missing-webhook-path", "local")).toMatchObject({
      status: "active",
      webhookPath: "/now-configured",
    });
  });

  it("judges deployment readiness against the local test worker, not Postgres heartbeats", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
    });

    expect(
      (await platform.getAutomationDeployment("hello-webhook", "local")).readiness,
    ).toMatchObject({
      matchingWorkerCount: 1,
      status: "ready",
      warnings: [],
    });
  });

  it("deploys, triggers by configured webhook path, processes, and inspects a successful run", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    const deployment = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "5ba6d004-b3ea-5978-ad33-b31711efa405",
    });

    expect(deployment.automationName).toBe("hello-webhook");
    expect(deployment.secretHealth).toEqual([]);

    const trigger = await platform.getAutomationTrigger("hello-webhook", "local");
    expect(trigger).toMatchObject({
      status: "active",
      triggerType: "webhook",
      webhookPath: "/hooks/hello",
    });

    const queuedRun = await platform.triggerWebhookByPath({
      environment: "local",
      path: "/hooks/hello",
      payload: { via: "platform" },
    });

    expect(queuedRun.status).toBe("queued");

    const processedRun = await platform.processNextPlatformRun();
    expect(processedRun).not.toBeNull();
    expect(processedRun?.status).toBe("succeeded");
    expect(processedRun?.result).toMatchObject({
      message: "Hello from Swizzle",
      payload: { via: "platform" },
    });

    const persistedRun = await platform.getPlatformRun(queuedRun.runId);
    expect(persistedRun.status).toBe("succeeded");
    expect(persistedRun.executions).toMatchObject([
      {
        executionNumber: 1,
        status: "succeeded",
      },
    ]);
  });

  it("treats byte-identical applies as no-ops unless forced", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      name: "deploy-sequence",
      triggerLines: ["  type: webhook", "  path: /deploy-sequence"],
    });

    const first = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "deefe068-3b13-5e6f-95d6-5de41fca5743",
    });
    expect(
      await platform.checkDeployment({ environment: "local", automationDirectory }),
    ).toMatchObject({ action: "noop", changes: [] });
    const second = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "d6d89ee4-bab3-5ab7-ad94-83d0eb6ef6c9",
    });
    const forced = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "ef00c088-e7c2-5f7b-92ca-9391733e50a9",
      force: true,
      skipReadinessCheck: true,
    });

    expect(first).toMatchObject({
      action: "create",
      deploymentId: "deefe068-3b13-5e6f-95d6-5de41fca5743",
      seq: 1,
    });
    expect(second).toMatchObject({
      action: "noop",
      deploymentId: "deefe068-3b13-5e6f-95d6-5de41fca5743",
      seq: 1,
    });
    expect(forced).toMatchObject({
      action: "update",
      deploymentId: "ef00c088-e7c2-5f7b-92ca-9391733e50a9",
      seq: 2,
    });

    const deployments = await platform.listAutomationDeployments("deploy-sequence", "local");
    expect(deployments.map((deployment) => deployment.seq).toSorted()).toEqual([1, 2]);
  });

  it("creates new sequences for changed source and config-only applies", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      name: "deploy-change",
      triggerLines: ["  type: webhook", "  path: /deploy-change"],
    });

    const first = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "5ec634ec-b038-5488-a68a-92601fd9b759",
    });

    await writeFile(
      path.join(automationDirectory, "main.js"),
      ["console.log(JSON.stringify({ changed: true }));", ""].join("\n"),
      "utf8",
    );
    const sourceChanged = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "2fce8d71-00e2-593b-9beb-cfbdf559562d",
    });

    await writeFile(
      path.join(automationDirectory, "config.yaml"),
      [
        "name: deploy-change",
        "version: 1.0.0",
        "entrypoint: main.js",
        "trigger:",
        "  type: webhook",
        "  path: /deploy-change-renamed",
        "",
      ].join("\n"),
      "utf8",
    );
    const configChanged = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "7923e02e-f314-5161-be1b-f9e5d4bc32c1",
    });

    expect(sourceChanged).toMatchObject({
      action: "update",
      deploymentId: "2fce8d71-00e2-593b-9beb-cfbdf559562d",
      seq: 2,
    });
    expect(sourceChanged.sourceHash).not.toBe(first.sourceHash);
    expect(configChanged).toMatchObject({
      action: "update",
      deploymentId: "7923e02e-f314-5161-be1b-f9e5d4bc32c1",
      seq: 3,
    });
    expect(configChanged.sourceHash).toBe(sourceChanged.sourceHash);

    const trigger = await platform.getAutomationTrigger("deploy-change", "local");
    expect(trigger.webhookPath).toBe("/deploy-change-renamed");
  });

  it("prevents webhook path collisions across active automations", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
    });

    await expect(
      platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: path.join(packageRoot, "test-fixtures/hello-webhook-collision"),
      }),
    ).rejects.toMatchObject({
      code: "TRIGGER_WEBHOOK_PATH_CONFLICT",
    });

    await expect(
      platform.getAutomationDeployment("hello-webhook-collision", "local"),
    ).rejects.toMatchObject({
      code: "ACTIVE_DEPLOYMENT_NOT_FOUND",
    });
    await expect(
      platform.getAutomationTrigger("hello-webhook-collision", "local"),
    ).rejects.toMatchObject({
      code: "TRIGGER_NOT_FOUND",
    });
    await expect(
      platform.listAutomationDeployments("hello-webhook-collision", "local"),
    ).resolves.toEqual([]);
    await expect(
      platform.listAutomationDeploymentAuditEvents("hello-webhook-collision", "local"),
    ).resolves.toEqual([]);
    // The failed first deploy leaves no automation behind to hold the name.
    expect(await platform.findAutomation("hello-webhook-collision")).toBeNull();

    const trigger = await platform.getAutomationTrigger("hello-webhook", "local");
    expect(trigger).toMatchObject({
      automationName: "hello-webhook",
      status: "active",
      webhookPath: "/hooks/hello",
    });
  });

  it("fails clearly when triggering an unknown webhook path", async () => {
    const platform = await testPlatform();

    await expect(
      platform.triggerWebhookByPath({ environment: "local", path: "/does-not-exist" }),
    ).rejects.toMatchObject({
      code: "TRIGGER_NOT_FOUND",
    });
  });

  it("rolls back to a previous deployment and runs on the rolled-back version", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    const firstDeployment = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "9669a9d3-f580-529d-beec-b0bce25a659e",
    });

    const secondDeployment = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "4ef64866-0901-54a8-b72f-232858c1b454",
      force: true,
      skipReadinessCheck: true,
    });

    expect(secondDeployment.deploymentId).toBe("4ef64866-0901-54a8-b72f-232858c1b454");

    const activeBeforeRollback = await platform.getAutomationDeployment("hello-webhook", "local");
    expect(activeBeforeRollback.deploymentId).toBe("4ef64866-0901-54a8-b72f-232858c1b454");

    const rolledBack = await platform.rollbackDeployment({
      environment: "local",
      automationName: "hello-webhook",
      targetDeploymentId: firstDeployment.deploymentId,
    });

    expect(rolledBack.deploymentId).not.toBe(firstDeployment.deploymentId);
    expect(rolledBack.version).toBe(firstDeployment.version);
    expect(rolledBack.sourceHash).toBe(firstDeployment.sourceHash);
    expect(rolledBack.status).toBe("active");

    const activeAfterRollback = await platform.getAutomationDeployment("hello-webhook", "local");
    expect(activeAfterRollback.deploymentId).toBe(rolledBack.deploymentId);

    const queuedRun = await platform.triggerWebhookByPath({
      environment: "local",
      path: "/hooks/hello",
      payload: { via: "rollback" },
    });
    expect(queuedRun.status).toBe("queued");

    const processedRun = await platform.processNextPlatformRun();
    expect(processedRun?.status).toBe("succeeded");
    expect(processedRun?.result).toMatchObject({
      message: "Hello from Swizzle",
      payload: { via: "rollback" },
    });

    const deployments = await platform.listAutomationDeployments("hello-webhook", "local");
    expect(deployments.length).toBe(3);
    expect(deployments.filter((d) => d.status === "active")).toHaveLength(1);

    const deployAudit = await platform.listAutomationDeploymentAuditEvents(
      "hello-webhook",
      "local",
    );
    expect(deployAudit.length).toBeGreaterThanOrEqual(3);
    expect(deployAudit.map((e) => e.change.eventType)).toContain("rollback");
    expect(deployAudit.map((e) => e.change.eventType)).toContain("deploy");
  });

  it("rejects rollback to a non-existent deployment", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
    });

    await expect(
      platform.rollbackDeployment({
        environment: "local",
        automationName: "hello-webhook",
        targetDeploymentId: "00000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toMatchObject({
      code: "DEPLOYMENT_NOT_FOUND",
    });
  });

  it("rejects a rollback target from another environment", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    const production = await platform.deployAutomationToPlatform({
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      environment: "production",
    });
    await platform.deployAutomationToPlatform({
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      environment: "staging",
    });

    await expect(
      platform.rollbackDeployment({
        automationName: "hello-webhook",
        environment: "staging",
        targetDeploymentId: production.deploymentId,
      }),
    ).rejects.toMatchObject({
      code: "DEPLOYMENT_NOT_FOUND",
    });
  });

  it("deletes an automation with its runs after its trigger is paused and frees its name", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const artifactsDirectory = path.join(stateDirectory, "artifacts");

    const platform = await testPlatform({ artifactsDirectory });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "8d633905-929f-50ac-b16d-89ddfbb789ec",
    });

    const run = await platform.triggerWebhookByPath({
      environment: "local",
      path: "/hooks/hello",
      payload: { phase: "before-delete" },
    });
    await platform.processNextPlatformRun();

    await expect(
      platform.deleteAutomation({ environment: "local", automationName: "hello-webhook" }),
    ).rejects.toMatchObject({ code: "AUTOMATION_NOT_PAUSED" });
    await platform.pauseAutomationTrigger("hello-webhook", "local");

    const result = await platform.deleteAutomation({
      environment: "local",
      automationName: "hello-webhook",
    });

    expect(result.automationSlug).toBe("hello-webhook");
    expect(result.artifactsRemoved).toBe(true);
    expect(result.artifactError).toBeNull();
    expect(result.deletedCounts).toEqual({ deployments: 1, runs: 1 });
    expect(result.kept.auditEvents).toBeGreaterThanOrEqual(1);
    await expect(platform.getPlatformRun(run.runId)).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
    expect(await platform.findAutomation("hello-webhook")).toBeNull();

    await expect(platform.getAutomationDeployment("hello-webhook", "local")).rejects.toMatchObject({
      code: "ACTIVE_DEPLOYMENT_NOT_FOUND",
    });

    await expect(
      rm(path.join(artifactsDirectory, "hello-webhook"), { recursive: true }),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const redeployed = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "35b84770-c9cd-50fd-a06b-a19a1dd86116",
    });
    expect(redeployed.automationId).not.toBe(result.automationId);
    // The new automation's trigger history starts empty: the deleted one keeps its own pause.
    await platform.pauseAutomationTrigger("hello-webhook", "local");
    const triggerHistory = await platform.listAutomationTriggerAuditEvents(
      "hello-webhook",
      "local",
    );
    expect(triggerHistory.map((event) => event.change.automationId)).toEqual([
      redeployed.automationId,
    ]);
  });

  it("sweeps old deployment artifacts while keeping the active deployment", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const artifactsDirectory = path.join(stateDirectory, "artifacts");

    const platform = await testPlatform({ artifactsDirectory });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "02db9455-fca4-56a1-bf46-9925e9048864",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "4a2b8028-8d15-5eea-b852-0853be4ae06c",
      force: true,
      skipReadinessCheck: true,
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "1f09c49d-c9f1-5ad6-a52f-d17b958d253d",
      force: true,
      skipReadinessCheck: true,
    });

    const deploymentArtifactPath = (deploymentId: string) =>
      path.join(artifactsDirectory, "hello-webhook", "1.0.0", deploymentId);

    const maintenance = await platform.runMaintenance({
      environment: "local",
      now: new Date("2026-01-01T00:00:00.000Z"),
      retention: { artifactRetentionDeployments: 2 },
    });

    expect(maintenance.artifactSweep).toMatchObject({
      deleted: 1,
      kept: 2,
      skipped: false,
    });
    await expect(
      access(deploymentArtifactPath("02db9455-fca4-56a1-bf46-9925e9048864")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(deploymentArtifactPath("4a2b8028-8d15-5eea-b852-0853be4ae06c")),
    ).resolves.toBeUndefined();
    await expect(
      access(deploymentArtifactPath("1f09c49d-c9f1-5ad6-a52f-d17b958d253d")),
    ).resolves.toBeUndefined();
  });

  it("keeps the artifact tree an active rollback shares with a swept target", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const artifactsDirectory = path.join(stateDirectory, "artifacts");

    const platform = await testPlatform({ artifactsDirectory });

    for (const deploymentId of [
      "299d565b-3858-57b0-a416-f1a41e987c03",
      "40142097-748b-5275-9a7e-e73534b9cecc",
      "2bf08710-dcef-59df-8108-3ae5a918b6e8",
    ]) {
      await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
        deploymentId,
        force: true,
        skipReadinessCheck: true,
      });
    }
    await platform.rollbackDeployment({
      environment: "local",
      automationName: "hello-webhook",
      targetDeploymentId: "299d565b-3858-57b0-a416-f1a41e987c03",
    });

    const maintenance = await platform.runMaintenance({
      environment: "local",
      retention: { artifactRetentionDeployments: 1 },
    });

    const deploymentArtifactPath = (deploymentId: string) =>
      path.join(artifactsDirectory, "hello-webhook", "1.0.0", deploymentId);
    await expect(
      access(deploymentArtifactPath("299d565b-3858-57b0-a416-f1a41e987c03")),
    ).resolves.toBeUndefined();
    await expect(
      access(deploymentArtifactPath("40142097-748b-5275-9a7e-e73534b9cecc")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(deploymentArtifactPath("2bf08710-dcef-59df-8108-3ae5a918b6e8")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(maintenance.artifactSweep).toMatchObject({ deleted: 2, kept: 2, skipped: false });

    await platform.triggerWebhookByPath({
      environment: "local",
      path: "/hooks/hello",
      payload: { via: "swept-rollback" },
    });
    const processedRun = await platform.processNextPlatformRun();
    expect(processedRun?.status).toBe("succeeded");
  });

  it("refuses to delete an automation while the trigger is still active", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "5ca70f94-2349-57bb-b22e-2ac2eadc9098",
    });

    await expect(
      platform.deleteAutomation({ environment: "local", automationName: "hello-webhook" }),
    ).rejects.toMatchObject({
      code: "AUTOMATION_NOT_PAUSED",
    });

    const stillActive = await platform.getAutomationDeployment("hello-webhook", "local");
    expect(stillActive.deploymentId).toBe("5ca70f94-2349-57bb-b22e-2ac2eadc9098");
  });

  it("rejects deleting an unknown automation", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await expect(
      platform.deleteAutomation({ environment: "local", automationName: "nonexistent" }),
    ).rejects.toMatchObject({
      code: "AUTOMATION_NOT_FOUND",
    });
  });
});
