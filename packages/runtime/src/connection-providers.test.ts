import { AUTOMATION_CONNECTION_PROVIDERS } from "@swizzle/config";
import { CONNECTION_PROVIDER_IDS } from "@swizzle/connections";
import { describe, expect, it } from "vitest";

// The config schema duplicates the provider id list (to stay dependency-light);
// this guards the two copies against drift.
describe("connection provider ids", () => {
  it("match between @swizzle/connections and @swizzle/config", () => {
    expect([...AUTOMATION_CONNECTION_PROVIDERS]).toEqual([...CONNECTION_PROVIDER_IDS]);
  });
});
