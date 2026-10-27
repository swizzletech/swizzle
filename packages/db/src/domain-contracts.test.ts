import type { AutomationConfig, automationConfigSchema } from "@swizzle/config";
import type { RunFinishedEvent, RunStatus } from "@swizzle/events";
import { expect, expectTypeOf, it } from "vitest";
import type { PlatformRunStatus, StoredDeployment, StoredRun } from "./control-plane-types.js";
import { isFinishedRun, isOpenRun } from "./run-status.js";

it("stores the schema-derived normalized config without a second document contract", () => {
  expectTypeOf<StoredDeployment["config"]>().toEqualTypeOf<AutomationConfig>();
  expectTypeOf<StoredRun["config"]>().toEqualTypeOf<AutomationConfig>();
  expectTypeOf<keyof AutomationConfig>().toEqualTypeOf<
    keyof ReturnType<typeof automationConfigSchema.parse>
  >();
  expectTypeOf<AutomationConfig["entrypoint"]>().toEqualTypeOf<string>();
  expectTypeOf<AutomationConfig["secrets"]>().toEqualTypeOf<readonly string[]>();
  type Chain = Extract<StoredDeployment["config"]["trigger"], { type: "chain" }>;
  expectTypeOf<Chain["sources"]>().toEqualTypeOf<readonly string[] | undefined>();
  expectTypeOf<Chain["on"]>().toEqualTypeOf<
    "succeeded" | "failed" | "dead-lettered" | "finished" | "all-succeeded"
  >();
  expectTypeOf<Chain["payload"]>().toEqualTypeOf<"result" | "payload" | "full" | "results">();
  expectTypeOf<"anything">().not.toExtend<Chain["on"]>();
  expectTypeOf<undefined>().not.toExtend<Chain["payload"]>();
});

it("shares event statuses while keeping waiting runs open and out of finished events", () => {
  expectTypeOf<PlatformRunStatus>().toEqualTypeOf<RunStatus>();
  expectTypeOf<"waiting">().toExtend<RunStatus>();
  expectTypeOf<"waiting">().not.toExtend<RunFinishedEvent["status"]>();
  expect(isOpenRun("waiting")).toBe(true);
  expect(isFinishedRun("waiting")).toBe(false);
  expect(isOpenRun("succeeded")).toBe(false);
  expect(isFinishedRun("succeeded")).toBe(true);
});
