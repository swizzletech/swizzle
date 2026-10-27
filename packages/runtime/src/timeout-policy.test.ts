import { describe, expect, it } from "vitest";

import {
  assertRuntimeTimeoutWithinPlatformCeiling,
  resolveEffectiveRunTimeoutCeiling,
  resolveEffectiveRuntimeTimeoutMs,
} from "./timeout-policy.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const GLOBAL_1H = { SWIZZLE_MAX_RUN_TIMEOUT: "1h" } satisfies NodeJS.ProcessEnv;

// The effective ceiling is max(global ceiling, timeout grant): a grant only ever raises it.
describe("resolveEffectiveRunTimeoutCeiling", () => {
  it("uses the global ceiling when there is no grant", () => {
    expect(resolveEffectiveRunTimeoutCeiling({ environment: GLOBAL_1H })).toMatchObject({
      grantApplied: false,
      label: "1h",
      milliseconds: HOUR,
    });
  });

  it("raises the ceiling to a larger grant", () => {
    expect(
      resolveEffectiveRunTimeoutCeiling({ environment: GLOBAL_1H, grantMaxTimeoutMs: 3 * HOUR }),
    ).toMatchObject({ grantApplied: true, label: "3h", milliseconds: 3 * HOUR });
  });

  it("never lowers the ceiling to a smaller grant", () => {
    expect(
      resolveEffectiveRunTimeoutCeiling({ environment: GLOBAL_1H, grantMaxTimeoutMs: 30 * MINUTE }),
    ).toMatchObject({ grantApplied: false, milliseconds: HOUR });
  });
});

describe("assertRuntimeTimeoutWithinPlatformCeiling", () => {
  it("rejects a timeout above the global ceiling and names the grant command", () => {
    expect(() =>
      assertRuntimeTimeoutWithinPlatformCeiling("2h", { environment: GLOBAL_1H }),
    ).toThrow(
      expect.objectContaining({
        code: "RUNTIME_TIMEOUT_EXCEEDS_MAX",
        message: expect.stringContaining("swizzle timeout-grant set"),
      }),
    );
  });

  it("accepts it under a sufficient grant and rejects it under a smaller one", () => {
    expect(
      assertRuntimeTimeoutWithinPlatformCeiling("2h", {
        environment: GLOBAL_1H,
        grantMaxTimeoutMs: 3 * HOUR,
      }),
    ).toMatchObject({ maxTimeoutMs: 3 * HOUR, timeoutMs: 2 * HOUR });
    expect(() =>
      assertRuntimeTimeoutWithinPlatformCeiling("2h", {
        environment: GLOBAL_1H,
        grantMaxTimeoutMs: 90 * MINUTE,
      }),
    ).toThrow(expect.objectContaining({ code: "RUNTIME_TIMEOUT_EXCEEDS_MAX" }));
  });
});

// The reconciler cuts off runs at this value.
describe("resolveEffectiveRuntimeTimeoutMs", () => {
  it("clamps to the global ceiling without a grant and to the grant with one", () => {
    expect(resolveEffectiveRuntimeTimeoutMs("3h", { environment: GLOBAL_1H })).toBe(HOUR);
    expect(
      resolveEffectiveRuntimeTimeoutMs("3h", {
        environment: GLOBAL_1H,
        grantMaxTimeoutMs: 3 * HOUR,
      }),
    ).toBe(3 * HOUR);
  });
});
