import { describe, expect, it } from "vitest";

import { mergeApiContact, untestedThresholdMs } from "./api-check-rules.js";

const key = { automationId: "automation-1", environment: "production" };
const sighting = (sunsetAt: string | null, at: string) => ({
  host: "api.example-bank.de",
  lastContactAt: at,
  lastOkAt: at,
  lastStatus: 200,
  notice:
    sunsetAt === null ? null : { deprecatedAt: null, path: "/v2/accounts", sunsetAt, url: null },
});

describe("mergeApiContact", () => {
  it("counts a notice as new once per announced sunset, and keeps it when later answers omit it", () => {
    const first = mergeApiContact(
      null,
      sighting("2026-12-31T00:00:00.000Z", "2026-10-01T00:00:00.000Z"),
      key,
    );
    const again = mergeApiContact(
      first.contact,
      sighting("2026-12-31T00:00:00.000Z", "2026-10-02T00:00:00.000Z"),
      key,
    );
    const quiet = mergeApiContact(again.contact, sighting(null, "2026-10-03T00:00:00.000Z"), key);
    const moved = mergeApiContact(
      quiet.contact,
      sighting("2027-03-31T00:00:00.000Z", "2026-10-04T00:00:00.000Z"),
      key,
    );

    expect([first.newNotice, again.newNotice, quiet.newNotice, moved.newNotice]).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(quiet.contact).toMatchObject({
      lastContactAt: "2026-10-03T00:00:00.000Z",
      noticeRuns: 2,
      noticeSeenAt: "2026-10-02T00:00:00.000Z",
      sunsetAt: "2026-12-31T00:00:00.000Z",
    });
  });

  it("keeps the newer notice when an older attempt finishes last", () => {
    const extended = mergeApiContact(
      null,
      sighting("2027-03-31T00:00:00.000Z", "2026-10-02T00:00:00.000Z"),
      key,
    );
    const late = mergeApiContact(
      extended.contact,
      sighting("2026-12-31T00:00:00.000Z", "2026-10-01T00:00:00.000Z"),
      key,
    );

    expect(late.newNotice).toBe(false);
    expect(late.contact).toMatchObject({
      lastContactAt: "2026-10-02T00:00:00.000Z",
      noticeRuns: 2,
      noticeSeenAt: "2026-10-02T00:00:00.000Z",
      sunsetAt: "2027-03-31T00:00:00.000Z",
    });
  });
});

describe("untestedThresholdMs", () => {
  const DAY = 86_400_000;
  const from = new Date("2026-10-01T00:00:00.000Z");

  it("waits twice the cron interval when that is longer than untested_after", () => {
    expect(untestedThresholdMs("30d", { cronIntervalMs: DAY, cronSchedule: null }, from)).toBe(
      30 * DAY,
    );
    expect(
      untestedThresholdMs("30d", { cronIntervalMs: null, cronSchedule: "0 6 1 * *" }, from),
    ).toBe(62 * DAY);
    expect(untestedThresholdMs("30d", null, from)).toBe(30 * DAY);
  });
});
