import { describe, expect, it } from "vitest";

import { durationInWords } from "./time";

describe("durationInWords", () => {
  it("carries a rounded remainder into the next hour", () => {
    expect(durationInWords(7_199_000)).toBe("2 h");
    expect(durationInWords(5_400_000)).toBe("1 h 30 min");
  });
});
