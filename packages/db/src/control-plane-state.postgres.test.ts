import { expect, it } from "vitest";
import { commitDeploymentFixture } from "../../../scripts/verify-state-fixtures.js";
import { testControlPlaneStore } from "../../../test/stores.js";

it("keeps state replacements and environments independent at the exact value limit", async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-boundary");
  const input = {
    automationId: deployment.automationId,
    environment: deployment.environment,
    updatedAt: new Date().toISOString(),
    key: "value",
  };
  const value = "é".repeat((64 * 1024 - 2) / 2);
  await store.setAutomationStateValue({ ...input, value });
  expect((await store.getAutomationStateValue(input))?.value).toBe(value);
  await store.setAutomationStateValue({ ...input, environment: "production", value: "other" });
  await expect(
    store.setAutomationStateValue({ ...input, value: `${value}x` }),
  ).rejects.toMatchObject({ code: "AUTOMATION_STATE_LIMIT_EXCEEDED" });
  expect((await store.getAutomationStateValue(input))?.value).toBe(value);
  await store.setAutomationStateValue({ ...input, value: { replaced: true } });
  expect((await store.getAutomationStateValue(input))?.value).toEqual({ replaced: true });
  expect(
    (await store.getAutomationStateValue({ ...input, environment: "production" }))?.value,
  ).toBe("other");
});

it("admits only one concurrent writer at the automation environment total boundary", async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "state-concurrent");
  const input = {
    automationId: deployment.automationId,
    environment: deployment.environment,
    updatedAt: new Date().toISOString(),
  };
  const value = "x".repeat(64 * 1024 - 2);
  for (let i = 0; i < 79; i++) {
    await store.setAutomationStateValue({ ...input, key: `seed-${i}`, value });
  }
  const outcomes = await Promise.allSettled([
    store.setAutomationStateValue({ ...input, key: "writer-a", value }),
    store.setAutomationStateValue({ ...input, key: "writer-b", value }),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
    reason: { code: "AUTOMATION_STATE_LIMIT_EXCEEDED" },
  });
  const entries = await store.listAutomationState(input);
  expect(
    entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.value)), 0),
  ).toBe(5 * 1024 * 1024);
});
