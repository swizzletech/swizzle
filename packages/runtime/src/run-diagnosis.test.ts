import { describe, expect, it } from "vitest";

import { buildDiagnosis } from "./run-diagnosis.js";

describe("buildDiagnosis", () => {
  it.each([
    ["EXTERNAL_CONNECTION_REFUSED", "Error: connect ECONNREFUSED 127.0.0.1:8080"],
    ["FILESYSTEM_PERMISSION_DENIED", "Error: EACCES: permission denied, open '/root/output.json'"],
    ["NODE_MODULE_MISSING", "Error: Cannot find module 'axios'"],
    ["PYTHON_MODULE_MISSING", "ModuleNotFoundError: No module named 'clickup'"],
    ["AUTOMATION_CRASHED", "some opaque crash without a known pattern"],
  ])("diagnoses %s from stderr", (code, stderr) => {
    const diagnosis = buildDiagnosis(deadLetteredRun(stderr), [], []);

    expect(diagnosis.likelyCause.code).toBe(code);
  });

  it("applies every matching stderr heuristic and dedupes identical fixes", () => {
    const diagnosis = buildDiagnosis(
      deadLetteredRun(
        "Cannot find module 'axios'\nCannot find module 'axios'\nEPERM: operation not permitted",
      ),
      [],
      [],
    );

    expect(diagnosis.evidence.map((evidence) => evidence.kind)).toEqual(
      expect.arrayContaining(["NODE_MODULE_MISSING", "FILESYSTEM_PERMISSION_DENIED"]),
    );
    expect(diagnosis.suggestedFixes.filter((fix) => fix.command === "pnpm add axios")).toHaveLength(
      1,
    );
  });

  it("explains a queued pinned run by its placement, with the service it needs, over an earlier error", () => {
    const diagnosis = buildDiagnosis(
      {
        ...deadLetteredRun("Error: boom"),
        environment: "production",
        projectId: "p-1",
        status: "queued",
        placement: {
          group: "gpu-home",
          services: ["local-llm"],
          wait: "no-worker",
          deadline: "2026-10-26T08:00:00.000Z",
          queueTimeout: "24h",
          workers: [],
        },
      },
      [],
      [],
    );

    expect(diagnosis.likelyCause).toEqual({
      code: "WAITING_FOR_WORKER",
      summary:
        'No worker is granted group "gpu-home" and local-llm for this project and environment. If no worker takes it within its queue_timeout of 24h, the run fails; it never runs in another group.',
    });
    expect(diagnosis.suggestedFixes.map((fix) => fix.command)).toEqual([
      "swizzle worker groups",
      "swizzle worker create <name> --project p-1 --environment production --groups gpu-home --local-llm",
    ]);
  });
});

// The run fields buildDiagnosis reads; the rest of the record does not affect it.
it("names who to assign when an approval's assignee matches nobody", () => {
  const message =
    "No person with the email nobody@example.com has an account here, so nobody could decide the approval gate.";
  const diagnosis = buildDiagnosis(
    { ...deadLetteredRun(""), errorCode: "APPROVAL_ASSIGNEE_NOT_FOUND", errorMessage: message },
    [],
    [],
  );

  expect(diagnosis.likelyCause).toEqual({ code: "APPROVAL_ASSIGNEE_NOT_FOUND", summary: message });
  expect(diagnosis.suggestedFixes.map((fix) => fix.rationale)).toEqual([
    "Invite that person (`swizzle people invite`) or create that team (`swizzle teams create`), or name an assignee who has an account here in the automation's requestApproval call, then run the automation again.",
  ]);
});

function deadLetteredRun(stderr: string): Parameters<typeof buildDiagnosis>[0] {
  return {
    attemptsMade: 3,
    attemptsMax: 3,
    automationName: "broken-automation",
    errorCode: "PROCESS_EXIT_NON_ZERO",
    errorMessage: "process crashed",
    runId: "run-1",
    status: "dead-lettered",
    stderr,
    triggerType: "webhook",
  };
}
