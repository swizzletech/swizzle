import { describe, expect, it } from "vitest";

import { ranOnInWords, runDetailStatusInWords, runDurationInWords, runStatusInWords } from "./runs";

const run = {
  approval: null,
  attemptsMade: 2,
  attemptsMax: 2,
  deadLetterReason: null,
  finishedAt: "2026-10-23T11:58:02.000Z",
  startedAt: "2026-10-23T11:58:00.000Z",
  wait: null,
} as const;

describe("ranOnInWords", () => {
  it("names one worker, or each attempt's when the run moved", () => {
    expect(ranOnInWords([])).toBe(null);
    expect(
      ranOnInWords([
        { executionNumber: 1, workerName: "gpu-box" },
        { executionNumber: 2, workerName: "gpu-box" },
      ]),
    ).toBe("gpu-box");
    expect(
      ranOnInWords([
        { executionNumber: 1, workerName: "gpu-box" },
        { executionNumber: 2, workerName: "laptop" },
      ]),
    ).toBe("1: gpu-box, 2: laptop");
  });
});

describe("runDurationInWords", () => {
  it("says a run no worker started has not started, and an unfinished one is still going", () => {
    expect(runDurationInWords({ ...run, finishedAt: null, startedAt: null })).toBe("Not started");
    expect(runDurationInWords({ ...run, finishedAt: null })).toBe("Still going");
    expect(runDurationInWords(run)).toBe("2.0 s");
  });
});

describe("runStatusInWords", () => {
  it.each([
    [{ ...run, status: "dead-lettered" as const }, "Failed after 2 attempts"],
    [{ ...run, deadLetterReason: "user-cancelled", status: "dead-lettered" as const }, "Cancelled"],
    [{ ...run, status: "succeeded" as const }, "Succeeded in 2.0 s"],
    [
      {
        ...run,
        approval: { assignee: null, details: null, stepKey: "gate" },
        status: "waiting" as const,
        wait: {
          reason: "event" as const,
          stepKey: "gate",
          until: null,
          details: null,
          startedAt: "2026-10-24T12:00:00.000Z",
        },
      },
      "Waiting for approval",
    ],
    [
      {
        ...run,
        status: "waiting" as const,
        wait: {
          reason: "event" as const,
          stepKey: "signal",
          until: null,
          details: null,
          startedAt: "2026-10-24T12:00:00.000Z",
        },
      },
      "Waiting for event signal",
    ],
  ])("words %#", (input, words) => {
    expect(runStatusInWords(input)).toBe(words);
  });
});

describe("runDetailStatusInWords", () => {
  it("shows preparation until the active execution is ready", () => {
    expect(
      runDetailStatusInWords({ ...run, status: "running", executions: [{ phase: "preparing" }] }),
    ).toBe("Preparing");
    expect(
      runDetailStatusInWords({ ...run, status: "running", executions: [{ phase: "executing" }] }),
    ).toBe("Running, attempt 2");
    expect(
      runDetailStatusInWords({ ...run, status: "succeeded", executions: [{ phase: "preparing" }] }),
    ).toBe("Succeeded in 2.0 s");
  });
});
