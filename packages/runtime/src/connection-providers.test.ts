import { AUTOMATION_CONNECTION_PROVIDERS } from "@swizzle/config";
import { CONNECTION_PROVIDER_IDS } from "@swizzle/connections";
import { describe, expect, it } from "vitest";

describe("connection provider ids", () => {
  it("match between @swizzle/connections and @swizzle/config", () => {
    expect([...AUTOMATION_CONNECTION_PROVIDERS]).toEqual([...CONNECTION_PROVIDER_IDS]);
  });
});
