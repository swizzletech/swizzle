import { describe, expect, it } from "vitest";

import { formatIntervalMs, parseIntervalToMs } from "./intervals.js";

// `trigger.every` is stored as milliseconds and shown again in the CLI and dashboard.
describe("trigger.every intervals", () => {
  it.each([
    ["45s", 45_000],
    ["2h30m", 9_000_000],
    ["1d", 86_400_000],
  ])("parses %s", (interval, ms) => {
    expect(parseIntervalToMs(interval)).toBe(ms);
  });

  it("rejects malformed and sub-30s intervals", () => {
    expect(() => parseIntervalToMs("5 minutes")).toThrow("Invalid interval format");
    expect(() => parseIntervalToMs("10s")).toThrow("Minimum interval is 30s");
  });

  it.each(["45s", "2m30s", "2h30m", "1d30s", "1d"])("formats %s back to itself", (interval) => {
    expect(formatIntervalMs(parseIntervalToMs(interval))).toBe(interval);
  });
});
