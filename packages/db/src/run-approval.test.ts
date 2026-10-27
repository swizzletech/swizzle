import { describe, expect, it } from "vitest";
import type { StoredRun } from "./control-plane-types.js";
import { getRunApproval, stepResultView, storedStepResult } from "./run-approval.js";

const waiting = {
  status: "waiting",
  wait: {
    stepKey: "gate",
    reason: "approval",
    assignee: { kind: "user" as const, label: "anna@example.com", userId: "user-anna" },
    details: { message: "Refund order 4411?" },
    until: null,
    startedAt: "2026-10-24T12:00:00.000Z",
  },
} satisfies Pick<StoredRun, "status" | "wait">;

it("projects the active approval from its run fields", () => {
  expect(getRunApproval(waiting)).toEqual({
    assignee: { kind: "user" as const, label: "anna@example.com", userId: "user-anna" },
    details: { message: "Refund order 4411?" },
    stepKey: "gate",
  });
  for (const run of [
    { ...waiting, status: "queued" as const },
    {
      ...waiting,
      wait: {
        reason: "event" as const,
        stepKey: "gate",
        until: null,
        details: null,
        startedAt: "2026-10-24T12:00:00.000Z",
      },
    },
    {
      ...waiting,
      wait: { reason: "sleep" as const, stepKey: "gate", until: "2026-10-24T12:00:00.000Z" },
    },
    { ...waiting, wait: { reason: "child" as const, stepKey: "gate" } },
    { ...waiting, wait: null },
  ]) {
    expect(getRunApproval(run)).toBeNull();
  }
});

describe("step result projection", () => {
  it("distinguishes a platform approval from identical user JSON", () => {
    const decision = {
      approved: true,
      assignee: { kind: "user" as const, label: "anna@example.com", userId: "user-anna" },
      comment: "Refund it",
      decidedAt: "2026-10-24T12:00:00.000Z",
      decidedBy: { kind: "person" as const, label: "anna@example.com", userId: "user-anna" },
      timedOut: false as const,
    };
    expect(stepResultView(storedStepResult({ approval: decision }))).toEqual({
      approval: decision,
      value: decision,
    });
    expect(stepResultView(storedStepResult({ value: decision }))).toEqual({
      approval: null,
      value: decision,
    });
    expect(stepResultView(null)).toEqual({ approval: null, value: null });
  });
});
