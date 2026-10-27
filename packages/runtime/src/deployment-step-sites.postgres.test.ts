import { rm } from "node:fs/promises";
import path from "node:path";
import { createDashboardStore } from "@swizzle/db/postgres";
import { expect, it } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import { temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";

it("keeps deployed step sites and visible invoke lanes without reading artifact storage", async () => {
  const artifactsDirectory = path.join(await temporaryDirectory("step-sites-"), "artifacts");
  const platform = await testPlatform({ artifactsDirectory });
  const deploy = async (name: string, mainJs?: string) =>
    await platform.deployAutomationToPlatform({
      automationDirectory: await createAutomationFixture({
        name,
        ...(mainJs === undefined ? {} : { mainJs }),
        triggerLines: ["  type: webhook", `  path: /${name}`],
      }),
      environment: "local",
    });
  await deploy("child-target");
  const parent = await deploy("parent-source", 'invokeAutomation("child", "child-target", {});');
  const stored = await platform.store.getDeploymentById(parent.deploymentId);
  expect(stored?.buildSnapshot.stepSites).toEqual([
    { key: "child", kind: "child", startLine: 1, endLine: 1, target: "child-target" },
  ]);

  await rm(artifactsDirectory, { recursive: true });
  const dashboard = createDashboardStore({ client: testDatabase() });
  const summaries = await dashboard.listAutomationSummaries("local", { all: true });
  expect(
    summaries.find((row) => row.automationSlug === "parent-source")?.invokesAutomationSlugs,
  ).toEqual(["child-target"]);
  expect(
    await dashboard.getAutomationDetail("parent-source", "local", { all: true }),
  ).toMatchObject({ invokesAutomationSlugs: ["child-target"] });
  expect(
    await dashboard.getAutomationDetail("parent-source", "local", {
      all: false,
      projectIds: [],
      automations: [{ automationId: parent.automationId, projectId: parent.projectId }],
    }),
  ).toMatchObject({ invokesAutomationSlugs: [] });
});
