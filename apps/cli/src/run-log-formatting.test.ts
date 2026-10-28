import { describe, expect, it } from "vitest";

import { runView, runViewTruncated, windowLog } from "./run-log-formatting.js";

type RunDetailRecord = Parameters<typeof runView>[0];

function baseRun(overrides: Partial<RunDetailRecord> = {}): RunDetailRecord {
  return {
    payload: { order: 42 },
    executions: [],
    environment: "staging",
    stdout: "",
    stderr: "",
    errorCode: null,
    errorMessage: null,
    deadLetterReason: null,
    wait: null,
    attemptsMade: 1,
    attemptsMax: 3,
    automationName: "hello-webhook",
    automationSlug: "hello-webhook",
    finishedAt: "2026-07-07T10:00:05Z",
    placement: null,
    queuedAt: "2026-07-07T10:00:00Z",
    runId: "run-123",
    startedAt: "2026-07-07T10:00:01Z",
    status: "succeeded",
    triggerType: "webhook",
    ...overrides,
  };
}

type Execution = RunDetailRecord["executions"][number];

/** Execution `executionNumber` of a run, spending `attempt`, on this machine unless named. */
function execution(
  executionNumber: number,
  attempt: number,
  overrides: Partial<Execution> = {},
): Execution {
  return {
    attempt,
    durationMs: null,
    errorMessage: null,
    executionNumber,
    metadata: {},
    resumedAfter: null,
    status: "succeeded",
    stderr: "",
    stdout: "",
    workerName: "local",
    ...overrides,
  };
}

describe("windowLog", () => {
  it("keeps the first and last bytes of a long log and counts what it cut", () => {
    const log = `${"a".repeat(10)}${"b".repeat(20)}${"c".repeat(10)}`;

    expect(windowLog(log, {}, 20)).toEqual({
      text: `${"a".repeat(10)}\n... (truncated 20 of 40 bytes) ...\n${"c".repeat(10)}`,
      totalBytes: 40,
      truncated: true,
    });
    expect(windowLog(log, { full: true }, 20)).toEqual({
      text: log,
      totalBytes: 40,
      truncated: false,
    });
  });

  it("cuts by lines for --head and --tail, and says so only when lines were left out", () => {
    const log = "one\ntwo\nthree";

    expect(windowLog(log, { head: 2 })).toEqual({
      text: "one\ntwo",
      totalBytes: 13,
      truncated: true,
    });
    expect(windowLog(log, { tail: 1 })).toEqual({ text: "three", totalBytes: 13, truncated: true });
    expect(windowLog(log, { tail: 5 }).truncated).toBe(false);
    expect(windowLog("one\ntwo\n", { tail: 1 })).toEqual({
      text: "two",
      totalBytes: 8,
      truncated: true,
    });
    expect(windowLog("one\ntwo\n", { head: 2 }).truncated).toBe(false);
  });
});

describe("runView", () => {
  it("says why a queued run waits in the words swizzle diagnose and the dashboard use", () => {
    const run = baseRun({
      status: "queued",
      placement: {
        group: "gpu-home",
        services: [],
        wait: "offline",
        words: { reason: "", summary: "", fixes: [] },
        deadline: "2026-07-08T10:00:00.000Z",
        queueTimeout: "24h",
        workers: [],
      },
    });

    expect(runView(run, false).waitingForWorker).toBe(
      'Every worker granted group "gpu-home" is offline, draining or not enrolled yet; the run starts when one comes online. Fails at 2026-07-08T10:00:00.000Z.',
    );
  });

  it("names the machine of the last attempt and of each attempt in the history", () => {
    const run = baseRun({
      executions: [
        execution(1, 1, { status: "failed", workerName: "gpu-home" }),
        execution(2, 2, { status: "succeeded", workerName: "local" }),
      ],
      attemptsMade: 2,
    });

    const view = runView(run, false);
    expect(view.worker).toBe("local");
    expect(view.attemptHistory?.map(({ attempt, worker }) => `${attempt}: ${worker}`)).toEqual([
      "1: gpu-home",
      "2: local",
    ]);
  });

  it("keeps the log of every execution, each under the attempt it spent", () => {
    const review = { reason: "approval", stepKey: "review" } as const;
    const suspended = execution(1, 1, { status: "suspended", stderr: "fetching\n" });
    const run = baseRun({
      executions: [
        suspended,
        execution(2, 1, { resumedAfter: review, status: "succeeded", stderr: "notifying" }),
      ],
      stderr: "notifying",
    });

    expect(runView(run, true).stderr).toBe(
      "--- execution 1, attempt 1 (suspended)\nfetching\n--- execution 2, attempt 1, resumed after approval review (succeeded)\nnotifying\n",
    );
    const silentLast = baseRun({
      executions: [
        suspended,
        execution(2, 1, { resumedAfter: review, status: "succeeded", stderr: "" }),
      ],
      stderr: "",
    });
    expect(runView(silentLast, true).stderr).toBe(
      "--- execution 1, attempt 1 (suspended)\nfetching\n",
    );
  });

  it("shows a JSON stdout as the result and previews stderr from its end", () => {
    const stderr = `${"x".repeat(2000)}the cause`;
    const run = baseRun({ stderr, stdout: '{"invoiceId": "abc", "amount": 76}' });

    const view = runView(run, false);

    expect(view).toMatchObject({ result: { amount: 76, invoiceId: "abc" } });
    expect(view.stderr).toBe(`... (last 1024 of 2009 bytes)\n${stderr.slice(-1024)}`);
    expect(runViewTruncated(run)).toBe(true);
    expect(runView(run, true).stderr).toBe(stderr);
  });

  it("keeps a stdout that is not JSON as text and offers --full only when it was cut", () => {
    const short = baseRun({ stdout: "not json" });

    expect(runView(short, false)).toMatchObject({ stdout: "not json" });
    expect(runView(short, false)).not.toHaveProperty("result");
    expect(runViewTruncated(short)).toBe(false);
    expect(runViewTruncated(baseRun({ stdout: `not json ${"x".repeat(2000)}` }))).toBe(true);
  });

  it("names a failed run's error and its dead-letter reason", () => {
    const view = runView(
      baseRun({
        deadLetterReason: "retries-exhausted",
        errorCode: "PROCESS_EXIT_NON_ZERO",
        errorMessage: "Automation exited with code 1.",
        status: "dead-lettered",
      }),
      false,
    );

    expect(view).toMatchObject({
      status: "dead-lettered",
      error: "PROCESS_EXIT_NON_ZERO: Automation exited with code 1.",
      deadLetterReason: "retries-exhausted",
    });
  });
});

it("keeps the original payload in a run inspection", () => {
  expect(runView(baseRun(), false)).toMatchObject({ payload: { order: 42 } });
});
