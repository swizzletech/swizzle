import { parseAutomationConfig } from "@swizzle/config";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { DeploymentTriggerInput } from "./control-plane-types.js";
import { buildDeploymentTriggerInput } from "./deployment-trigger-input.js";

it("keeps webhook and chain fields on their own trigger variants", () => {
  expectTypeOf<DeploymentTriggerInput>()
    .extract<{ triggerType: "webhook" }>()
    .toHaveProperty("webhookPath");
  expectTypeOf<DeploymentTriggerInput>()
    .extract<{ triggerType: "webhook" }>()
    .not.toHaveProperty("chainSourceAutomationIds");
  expectTypeOf<DeploymentTriggerInput>()
    .extract<{ triggerType: "chain" }>()
    .toHaveProperty("chainSourceAutomationIds");
});

describe("chain trigger cycle check", () => {
  // target -> x -> y downstream; a, b and c are upstream of nothing.
  const downstream: Record<string, readonly string[]> = { target: ["x"], x: ["y"] };

  const build = async (sources: readonly string[]) => {
    const visited: string[] = [];
    const input = await buildDeploymentTriggerInput(
      {
        automationId: "target",
        projectId: "office",
        config: {
          trigger: {
            type: "chain",
            sources: [...sources],
            on: "all-succeeded",
            payload: "results",
          },
        },
        deployedAt: "2026-10-23T00:00:00.000Z",
        deploymentId: "deployment-target",
        environment: "local",
        versionId: "version-target",
      },
      {
        getActiveDeploymentBySlug: async (slug) => ({ automationId: slug, projectId: "office" }),
        getChainTriggersForSource: async (sourceAutomationId) => {
          visited.push(sourceAutomationId);
          return (downstream[sourceAutomationId] ?? []).map((automationId) => ({ automationId }));
        },
      },
    );
    return { input, visited };
  };

  it("walks the target's downstream graph once for a join", async () => {
    const { input, visited } = await build(["a", "b", "c"]);

    expect(input).toMatchObject({ chainSourceAutomationIds: ["a", "b", "c"] });
    expect(input).not.toHaveProperty("errorCode");
    expect(visited).toEqual(["target", "x", "y"]);
  });

  it("names the join source that would close a cycle", async () => {
    expect((await build(["a", "y"])).input).toMatchObject({
      errorMessage: "Chain trigger would create a cycle through source automation: y",
    });
    expect((await build(["a", "target"])).input).toMatchObject({
      errorMessage: "Chain trigger would create a cycle through source automation: target",
    });
  });
});

it.each([
  ["source: upstream", "succeeded", "result", ["upstream"]],
  ["sources: [upstream, other]", "all-succeeded", "results", ["upstream", "other"]],
  ["source: upstream\n  on: finished\n  payload: full", "finished", "full", ["upstream"]],
] as const)(
  "derives chain rows from normalized config: %s",
  async (fields, on, payload, sources) => {
    const config = parseAutomationConfig(`name: target
version: "1"
trigger:
  type: chain
  ${fields}
`);
    const input = await buildDeploymentTriggerInput(
      {
        automationId: "target",
        projectId: "office",
        config,
        deployedAt: "2026-10-25T00:00:00.000Z",
        deploymentId: "deployment-target",
        environment: "local",
        versionId: "version-target",
      },
      {
        getActiveDeploymentBySlug: async (slug) => ({ automationId: slug, projectId: "office" }),
        getChainTriggersForSource: async () => [],
      },
    );
    expect(config.entrypoint).toBe("main.py");
    expect(input).toEqual({
      automationId: "target",
      deploymentId: "deployment-target",
      environment: "local",
      updatedAt: "2026-10-25T00:00:00.000Z",
      versionId: "version-target",
      triggerType: "chain",
      chainOnStatus: on,
      chainPayloadMode: payload,
      chainSourceAutomationId: sources.length === 1 ? "upstream" : null,
      chainSourceAutomationIds: sources.length === 1 ? [] : [...sources],
    });
  },
);
