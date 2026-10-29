import { describe, expect, it } from "vitest";

import { durationInWords } from "./time";

describe("durationInWords", () => {
  it("carries a rounded remainder into the next hour", () => {
    expect(durationInWords(7_199_000)).toBe("2 h");
    expect(durationInWords(5_400_000)).toBe("1 h 30 min");
  });
});

describe("durationInWords under a second", () => {
  it("says milliseconds below 50 ms, so a quick step does not read 0.0 s", () => {
    expect(durationInWords(12)).toBe("12 ms");
    expect(durationInWords(49.6)).toBe("50 ms");
    expect(durationInWords(50)).toBe("0.1 s");
  });
});
