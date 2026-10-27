import { readdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testAccessStore } from "../../../test/stores.js";
import { temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";

it("persists webhook, cron, interval and chain trigger inputs through the PostgreSQL store", async () => {
  const directory = await temporaryDirectory("swizzle-deployment-triggers-");
  const platform = await testPlatform({
    artifactsDirectory: path.join(directory, "artifacts"),
  });
  const cases = [
    {
      name: "source",
      triggerLines: ["  type: webhook", "  path: //shared-source/"],
      expected: { triggerType: "webhook", webhookPath: "/shared-source", nextRunAt: null },
    },
    {
      name: "cron",
      triggerLines: ["  type: cron", '  schedule: "0 0 1 1 *"'],
      expected: { triggerType: "cron", cronSchedule: "0 0 1 1 *", cronIntervalMs: null },
    },
    {
      name: "every",
      triggerLines: ["  type: cron", "  every: 1h"],
      expected: { triggerType: "cron", cronSchedule: null, cronIntervalMs: 3600000 },
    },
    {
      name: "chain",
      triggerLines: ["  type: chain", "  source: shared-source"],
      expected: {
        triggerType: "chain",
        chainOnStatus: "succeeded",
        chainPayloadMode: "result",
        nextRunAt: null,
      },
    },
  ];
  for (const example of cases) {
    const automationName = `shared-${example.name}`;
    const automationDirectory = await createAutomationFixture({
      name: automationName,
      triggerLines: example.triggerLines,
    });
    const deployment = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
    });
    const trigger = await platform.getAutomationTrigger(automationName, "local");
    expect(trigger).toMatchObject({
      ...example.expected,
      status: "active",
      errorCode: null,
      deploymentId: deployment.deploymentId,
    });
    if (example.name === "chain")
      expect(trigger.chainSourceAutomationId).toBe(
        (await platform.getAutomationTrigger("shared-source", "local")).automationId,
      );
    if (example.name === "every")
      expect(trigger.nextRunAt).toBe(
        new Date(Date.parse(deployment.deployedAt) + 3600000).toISOString(),
      );
  }
});

it("clears trigger-specific state when an automation changes kind and rejects a chain cycle", async () => {
  const directory = await temporaryDirectory("swizzle-trigger-kinds-");
  const platform = await testPlatform({
    artifactsDirectory: path.join(directory, "artifacts"),
  });
  const deploy = async (name: string, triggerLines: string[]) => {
    const automationDirectory = await createAutomationFixture({ name, triggerLines });
    return await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      force: true,
    });
  };
  await deploy("kind-source", ["  type: webhook", "  path: //kind-source/"]);
  await deploy("kind-other", ["  type: webhook", "  path: /kind-other"]);
  await deploy("kind-target", ["  type: chain", "  sources: [kind-source, kind-other]"]);
  expect(await platform.getAutomationTrigger("kind-target", "local")).toMatchObject({
    triggerType: "chain",
    chainOnStatus: "all-succeeded",
    chainPayloadMode: "results",
  });
  await deploy("kind-source", ["  type: chain", "  source: kind-target"]);
  expect(await platform.getAutomationTrigger("kind-source", "local")).toMatchObject({
    status: "invalid",
    errorCode: "TRIGGER_CONFIGURATION_INVALID",
    errorMessage: "Chain trigger would create a cycle through source automation: kind-target",
    webhookPath: null,
  });
  await deploy("kind-target", ["  type: cron", "  every: 1h"]);
  expect(await platform.getAutomationTrigger("kind-target", "local")).toMatchObject({
    triggerType: "cron",
    chainOnStatus: null,
    chainPayloadMode: null,
    chainSourceAutomationId: null,
    chainSourceAutomationIds: [],
    cronIntervalMs: 3600000,
  });
  await deploy("kind-target", ["  type: webhook", "  path: //kind-target/"]);
  expect(await platform.getAutomationTrigger("kind-target", "local")).toMatchObject({
    triggerType: "webhook",
    webhookPath: "/kind-target",
    cronSchedule: null,
    cronIntervalMs: null,
    nextRunAt: null,
    chainSourceAutomationIds: [],
  });
});

it("keeps a whitespace-only cron schedule invalid and unscheduled", async () => {
  const directory = await temporaryDirectory("swizzle-blank-cron-");
  const platform = await testPlatform({
    artifactsDirectory: path.join(directory, "artifacts"),
  });
  const automationDirectory = await createAutomationFixture({
    name: "blank-cron",
    triggerLines: ["  type: cron", '  schedule: "   "'],
  });
  await platform.deployAutomationToPlatform({ environment: "local", automationDirectory });
  expect(await platform.getAutomationTrigger("blank-cron", "local")).toMatchObject({
    triggerType: "cron",
    status: "invalid",
    errorCode: "TRIGGER_CRON_SCHEDULE_MISSING",
    nextRunAt: null,
  });
});

it("refuses missing and other-project chain sources before publishing config or artifacts", async () => {
  const directory = await temporaryDirectory("swizzle-chain-projects-");
  const artifactsDirectory = path.join(directory, "artifacts");
  const platform = await testPlatform({ artifactsDirectory });
  const deploy = async (name: string, projectId: string, triggerLines: string[]) =>
    platform.deployAutomationToPlatform({
      automationDirectory: await createAutomationFixture({ name, triggerLines }),
      environment: "local",
      project: async () => projectId,
    });
  const access = testAccessStore();
  const finance = await access.createProject({ slug: "finance", name: "Finance" });
  const office = await access.createProject({ slug: "office", name: "Office" });
  await deploy("ledger", finance.id, ["  type: webhook", "  path: /ledger"]);
  await deploy("intake", office.id, ["  type: webhook", "  path: /intake"]);
  for (const source of ["ledger", "absent"]) {
    for (const line of [`  source: ${source}`, `  sources: [intake, ${source}]`]) {
      await expect(deploy("consumer", office.id, ["  type: chain", line])).rejects.toMatchObject({
        code: "TRIGGER_CONFIGURATION_INVALID",
        message: `Chain source automation not found: ${source}`,
      });
      expect(await platform.findAutomation("consumer")).toBeNull();
      expect(await platform.listAutomationDeployments("consumer", "local")).toEqual([]);
      await expect(platform.getAutomationTrigger("consumer", "local")).rejects.toMatchObject({
        code: "TRIGGER_NOT_FOUND",
      });
      expect((await readdir(artifactsDirectory)).sort()).toEqual(["intake", "ledger"]);
    }
  }
  const valid = await deploy("consumer", office.id, ["  type: chain", "  source: intake"]);
  const artifactFiles = (await readdir(artifactsDirectory, { recursive: true })).sort();
  for (const source of ["ledger", "absent"]) {
    await expect(
      deploy("consumer", office.id, ["  type: chain", `  source: ${source}`]),
    ).rejects.toMatchObject({
      code: "TRIGGER_CONFIGURATION_INVALID",
      message: `Chain source automation not found: ${source}`,
    });
    expect(await platform.getAutomationDeployment("consumer", "local")).toMatchObject({
      deploymentId: valid.deploymentId,
      versionId: valid.versionId,
      config: { trigger: { type: "chain", source: "intake" } },
    });
    expect(await platform.listAutomationDeployments("consumer", "local")).toMatchObject([
      {
        deploymentId: valid.deploymentId,
        versionId: valid.versionId,
        config: { trigger: { type: "chain", source: "intake" } },
      },
    ]);
    expect(await platform.getAutomationTrigger("consumer", "local")).toMatchObject({
      status: "active",
      deploymentId: valid.deploymentId,
      chainOnStatus: "succeeded",
      errorCode: null,
    });
    expect((await readdir(artifactsDirectory, { recursive: true })).sort()).toEqual(artifactFiles);
  }
});

it("refuses to split paused single-source and join chains when moving an automation", async () => {
  const directory = await temporaryDirectory("swizzle-chain-moves-");
  const platform = await testPlatform({
    artifactsDirectory: path.join(directory, "artifacts"),
  });
  for (const [name, triggerLines] of [
    ["move-first", ["  type: webhook", "  path: /move-first"]],
    ["move-second", ["  type: webhook", "  path: /move-second"]],
    ["move-single", ["  type: chain", "  source: move-first"]],
    ["move-join", ["  type: chain", "  sources: [move-first, move-second]"]],
  ] as const) {
    await platform.deployAutomationToPlatform({
      automationDirectory: await createAutomationFixture({ name, triggerLines }),
      environment: "local",
    });
    await platform.pauseAutomationTrigger(name, "local");
  }
  for (const [name, connected] of [
    ["move-first", ["move-join", "move-single"]],
    ["move-second", ["move-join"]],
    ["move-single", ["move-first"]],
    ["move-join", ["move-first", "move-second"]],
  ] as const) {
    await expect(platform.moveAutomation(name, "elsewhere")).rejects.toMatchObject({
      code: "AUTOMATION_CHAIN_CONNECTED",
      details: { automations: connected },
    });
  }
});
