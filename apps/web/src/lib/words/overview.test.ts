import { describe, expect, it } from "vitest";

import {
  failedRunHandoff,
  failingAutomationHandoff,
  platformProblemInWords,
  statusSentence,
} from "./overview";

describe("statusSentence", () => {
  it("counts what needs the owner, in the right number", () => {
    expect(statusSentence({ complete: true, needsYou: [] })).toEqual({
      emphasis: "good.",
      lead: "All",
    });
    expect(
      statusSentence({
        complete: true,
        needsYou: [
          {
            kind: "platform",
            problem: { code: "scheduler-down", environment: "local", served: [] },
          },
        ],
      }),
    ).toEqual({ emphasis: "needs you.", lead: "1 thing" });
  });

  it("does not call all good what a reader's role keeps out of their Needs you", () => {
    expect(statusSentence({ complete: false, needsYou: [] })).toEqual({
      emphasis: "needs you.",
      lead: "Nothing",
    });
  });
});

describe("platformProblemInWords", () => {
  it("names the environment a missing scheduler leaves without timed runs", () => {
    expect(
      platformProblemInWords({ code: "scheduler-down", environment: "production", served: [] }),
    ).toEqual({
      title:
        "No scheduler runs for production, so its cron runs do not start and its waits do not end.",
      todo: "Run `just stack` in the checkout on the server: it rebuilds the images and starts the scheduler from the current code. One scheduler serves every environment.",
    });
    // An older scheduler may still report only one namespace during an upgrade.
    expect(
      platformProblemInWords({
        code: "scheduler-down",
        environment: "production",
        served: ["staging"],
      }),
    ).toEqual({
      title:
        "No scheduler runs for production, so its cron runs do not start and its waits do not end.",
      todo: "Run `just stack` in the checkout on the server: it rebuilds the images and starts the scheduler from the current code. One scheduler serves every environment.",
    });
  });
});

describe("failedRunHandoff", () => {
  it("names the run, the error and the commands to investigate with", () => {
    expect(
      failedRunHandoff({
        attemptsMade: 2,
        automationName: "verify-probe",
        errorMessage: "Automation exited with code 1.",
        runId: "4f66e011",
        triggerType: "webhook",
      }),
    ).toBe(
      "Run 4f66e011 of verify-probe failed after 2 attempts: Automation exited with code 1. " +
        "Investigate with `swizzle diagnose 4f66e011` and `swizzle logs --run 4f66e011`, " +
        "fix the cause, redeploy, then replay with `swizzle runs replay 4f66e011`, which carries no signed delivery: " +
        "if the automation checks the webhook signature, ask the sender to redeliver instead.",
    );
  });

  it("keeps the stored error and adds a diagnosis that differs", () => {
    const handoff = failedRunHandoff({
      attemptsMade: 1,
      automationName: "digest",
      diagnosisSummary: "The API key is missing.",
      errorMessage: "Automation exited with code 1.",
      runId: "r1",
      triggerType: "manual",
    });
    expect(handoff).toContain(
      "failed after 1 attempt: Automation exited with code 1. Diagnosis: The API key is missing. Investigate",
    );
  });

  it("does not repeat a diagnosis equal to the stored error", () => {
    const handoff = failedRunHandoff({
      attemptsMade: 1,
      automationName: "digest",
      diagnosisSummary: "Automation exited with code 1.",
      errorMessage: "Automation exited with code 1.",
      runId: "r1",
      triggerType: "manual",
    });
    expect(handoff).not.toContain("Diagnosis:");
  });

  it("tells the agent a webhook run needs the sender to redeliver when it checks the signature", () => {
    const handoff = failedRunHandoff({
      attemptsMade: 1,
      automationName: "hook",
      errorMessage: "Bad signature.",
      runId: "w1",
      triggerType: "webhook",
    });
    expect(handoff).toContain(
      "if the automation checks the webhook signature, ask the sender to redeliver instead",
    );
  });

  it("sends a chain run back through its source, not to replay", () => {
    expect(
      failedRunHandoff({
        attemptsMade: 1,
        automationName: "digest",
        errorMessage: "Automation exited with code 1.",
        runId: "9a1b2c3d",
        triggerType: "chain",
      }),
    ).toBe(
      "Run 9a1b2c3d of digest failed after 1 attempt: Automation exited with code 1. " +
        "Investigate with `swizzle diagnose 9a1b2c3d` and `swizzle logs --run 9a1b2c3d`, " +
        "fix the cause, redeploy, then start it again through its source, because a chain run cannot be replayed.",
    );
  });
});

describe("failingAutomationHandoff", () => {
  const failing = (lastFailedTriggerType: "chain" | "webhook" | "manual") =>
    failingAutomationHandoff({
      automation: { automationName: "digest", automationSlug: "digest" },
      errorCode: null,
      errorMessage: "Automation exited with code 1.",
      failedRuns: 2,
      kind: "failing",
      lastFailedAt: "2026-10-28T10:00:00.000Z",
      lastFailedRunId: "9a1b2c3d",
      lastFailedTriggerType,
      recentRuns: 4,
    });

  it("starts a failing chain automation through its source, not by replay", () => {
    const handoff = failing("chain");
    expect(handoff).toContain("start it again through its source");
    expect(handoff).not.toContain("swizzle runs replay");
  });

  it("replays a manual run and warns about webhook signatures for a webhook run", () => {
    expect(failing("manual")).toContain("replay with `swizzle runs replay 9a1b2c3d`.");
    expect(failing("webhook")).toContain("ask the sender to redeliver instead");
  });
});
