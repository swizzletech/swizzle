import { describe, expect, it } from "vitest";

import {
  ranOnInWords,
  runCountInWords,
  runDetailStatusInWords,
  runDurationInWords,
  runRowInWords,
  runStatusInWords,
} from "./runs";

const run = {
  approval: null,
  attemptsMade: 2,
  attemptsMax: 2,
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
    [{ ...run, state: "dead-lettered" as const }, "Failed after 2 attempts"],
    [{ ...run, state: "cancelled" as const }, "Cancelled"],
    [{ ...run, state: "succeeded" as const }, "Succeeded in 2.0 s"],
    [
      {
        ...run,
        approval: { assignee: null, details: null, stepKey: "gate" },
        state: "waiting" as const,
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
        state: "waiting" as const,
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
      runDetailStatusInWords({ ...run, state: "running", executions: [{ phase: "preparing" }] }),
    ).toBe("Preparing");
    expect(
      runDetailStatusInWords({ ...run, state: "running", executions: [{ phase: "executing" }] }),
    ).toBe("Running, attempt 2");
    expect(
      runDetailStatusInWords({ ...run, state: "succeeded", executions: [{ phase: "preparing" }] }),
    ).toBe("Succeeded in 2.0 s");
  });
});

describe("runRowInWords", () => {
  const failed = {
    ...run,
    attemptsMade: 3,
    automationName: "Invoices",
    state: "failed",
    triggerType: "cron",
    version: "1.3.1",
  } as const;

  it("leads with the automation in a list of all runs", () => {
    expect(runRowInWords(failed, "automation")).toEqual({
      line: "Failed · 3 attempts · 2.0 s",
      title: "Invoices",
    });
  });

  it("leads with the state on one automation's page, where the name is the page's", () => {
    expect(runRowInWords(failed, "state")).toEqual({
      line: "3 attempts · 2.0 s · cron · v1.3.1",
      title: "Failed",
    });
  });

  it("calls a run its owner cancelled cancelled, and leaves out one attempt", () => {
    const cancelled = {
      ...failed,
      attemptsMade: 1,
      state: "cancelled",
    } as const;
    expect(runRowInWords(cancelled, "automation").line).toBe("Cancelled · 2.0 s");
  });
});

describe("runCountInWords", () => {
  it("says a loaded count is the newest until the list reached its end", () => {
    expect(runCountInWords(100, false)).toBe("100 newest");
    expect(runCountInWords(451, true)).toBe("451 runs");
    expect(runCountInWords(1, true)).toBe("1 run");
  });
});
