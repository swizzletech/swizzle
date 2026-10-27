import { describe, expect, it } from "vitest";

import type { TrackStep } from "./track";
import { mergeStepEvents } from "./use-run-track";

function row(
  stepKey: string,
  executionNumber: number,
  startedAt: string,
  finishedAt: string | null,
): TrackStep {
  return {
    approval: null,
    attempt: 1,
    executionNumber,
    createdAt: startedAt,
    finishedAt,
    startedAt,
    stepKey,
    updatedAt: finishedAt ?? startedAt,
    value: null,
  };
}

/** The counters of an event from execution `executionNumber`, which spends attempt 1. */
const counters = (executionNumber: number) => ({ attempt: 1, executionNumber });

describe("mergeStepEvents", () => {
  it("lights a step the read has not seen and finishes one it saw started", () => {
    const merged = mergeStepEvents(
      [row("fetch", 1, "2026-10-24T10:00:00.000Z", null)],
      [
        { ...counters(1), key: "fetch", status: "done", timestamp: "2026-10-24T10:00:01.500Z" },
        {
          attempt: 2,
          executionNumber: 3,
          key: "notify",
          status: "started",
          timestamp: "2026-10-24T10:00:02.000Z",
        },
      ],
    );
    expect(merged).toEqual([
      expect.objectContaining({ finishedAt: "2026-10-24T10:00:01.500Z", stepKey: "fetch" }),
      expect.objectContaining({
        attempt: 2,
        executionNumber: 3,
        finishedAt: null,
        startedAt: "2026-10-24T10:00:02.000Z",
        stepKey: "notify",
      }),
    ]);
  });

  it("keeps a finished row and a newer execution's start over retained older events", () => {
    const read = [
      row("fetch", 1, "2026-10-24T10:00:00.000Z", "2026-10-24T10:00:01.000Z"),
      row("notify", 2, "2026-10-24T10:00:30.000Z", null),
    ];
    const merged = mergeStepEvents(read, [
      { ...counters(1), key: "fetch", status: "started", timestamp: "2026-10-24T10:00:00.000Z" },
      { ...counters(1), key: "notify", status: "started", timestamp: "2026-10-24T10:00:02.000Z" },
      { ...counters(2), key: "notify", status: "started", timestamp: "2026-10-24T10:00:29.000Z" },
    ]);
    expect(merged).toEqual(read);
  });
});
