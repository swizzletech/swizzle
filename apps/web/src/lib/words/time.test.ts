import { describe, expect, it } from "vitest";

import { dayInWords, durationInWords } from "./time";

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

describe("dayInWords", () => {
  const now = new Date(2026, 10, 6, 12);

  it("names today and yesterday by word, and every other day by weekday", () => {
    expect(dayInWords(new Date(2026, 10, 6, 0, 5).toISOString(), now)).toEqual({
      date: "6 Nov",
      name: "Today",
    });
    expect(dayInWords(new Date(2026, 10, 5, 23, 55).toISOString(), now)).toEqual({
      date: "5 Nov",
      name: "Yesterday",
    });
    expect(dayInWords(new Date(2026, 10, 3, 8).toISOString(), now)).toEqual({
      date: "3 Nov",
      name: "Tuesday",
    });
  });

  it("names the year of a day in another year", () => {
    expect(dayInWords(new Date(2025, 11, 31, 8).toISOString(), now).date).toBe("31 Dec 2025");
  });
});
