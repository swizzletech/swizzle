import { describe, expect, it } from "vitest";

import { auditActionInWords } from "./audit";

const paused = {
  automationId: "automation-1",
  automationName: "Refunds",
  automationSlug: "refunds",
  deploymentId: "deployment-1",
  environment: "staging",
  eventType: "trigger_paused",
  kind: "trigger",
  metadata: {},
  projectId: "project-1",
  runId: null,
  triggerId: "trigger-1",
  triggerType: "webhook",
} as const;

describe("audit actions in words", () => {
  it("names a run started by hand as such, and a request by its route over its change", () => {
    expect(
      auditActionInWords({
        action: "POST /automations/:automationName/runs",
        status: 200,
      }),
    ).toBe("Started a run");
    expect(
      auditActionInWords({
        action: "POST /automations/:automationName/trigger/pause",
        change: paused,
        status: 200,
      }),
    ).toBe("Paused the trigger");
    expect(auditActionInWords({ action: "trigger_paused", change: paused, status: null })).toBe(
      "Paused trigger",
    );
  });

  it("names approval and event decisions and a refusal in words", () => {
    expect(
      auditActionInWords({ action: "POST /runs/:runId/approvals/:stepKey", status: 200 }),
    ).toBe("Decided an approval");
    expect(
      auditActionInWords({ action: "PUT /runs/:runId/approvals/:stepKey/assignee", status: 200 }),
    ).toBe("Reassigned an approval");
    expect(auditActionInWords({ action: "POST /runs/:runId/events/:stepKey", status: 403 })).toBe(
      "Sent an event to a run: refused, not allowed",
    );
  });
});
