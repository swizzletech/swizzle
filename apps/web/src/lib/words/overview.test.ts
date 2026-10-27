import { describe, expect, it } from "vitest";

import { failedRunHandoff, platformProblemInWords, statusSentence } from "./overview";

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
      todo: "Start it with `docker compose up -d scheduler` on the server.",
    });
    // The stack's scheduler is healthy, but serves the environment its .env names.
    expect(
      platformProblemInWords({
        code: "scheduler-down",
        environment: "production",
        served: ["staging"],
      }),
    ).toEqual({
      title:
        "No scheduler runs for production, so its cron runs do not start and its waits do not end.",
      todo: "The scheduler serves staging. Deploy to staging, or set `SWIZZLE_ENVIRONMENT=production` in `.env` and run `just stack` on the server.",
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
      }),
    ).toBe(
      "Run 4f66e011 of verify-probe failed after 2 attempts: Automation exited with code 1. " +
        "Investigate with `swizzle diagnose 4f66e011` and `swizzle logs --run 4f66e011`, " +
        "fix the cause and redeploy.",
    );
  });
});
