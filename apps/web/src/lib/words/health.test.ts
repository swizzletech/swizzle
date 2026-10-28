import { describe, expect, it } from "vitest";

import type { AutomationSummary, RuntimeReadiness } from "../api";
import { automationHealth, readinessInWords, readinessLabel } from "./health";

const NOW = new Date("2026-10-23T12:00:00.000Z");

describe("automationHealth", () => {
  const base = {
    activeDeployment: { readiness: { errors: [], status: "ready" } },
    recentRuns: [],
    requiredConnections: [],
    requiredSecrets: [],
    trigger: { status: "active" },
  } as unknown as AutomationSummary;
  const glance = (status: "failed" | "waiting") => ({
    errorCode: null,
    errorMessage: null,
    queuedAt: NOW.toISOString(),
    runId: status,
    status,
    triggerType: "manual" as const,
  });

  it("puts what blocks a run before the last result, and waiting is not failing", () => {
    // A persisted limit no worker allows blocks the automation as surely as a missing secret.
    expect(
      automationHealth({
        ...base,
        activeDeployment: {
          readiness: {
            errors: [{ code: "RUNTIME_CONTAINER_LIMIT_EXCEEDS_MAX", subject: "memory_mb" }],
            status: "not-ready",
          },
        },
        recentRuns: [glance("failed")],
      } as unknown as AutomationSummary),
    ).toBe("blocked");
    expect(automationHealth({ ...base, recentRuns: [glance("waiting")] })).toBe("waiting");
    expect(automationHealth(base)).toBe("idle");
  });
});

describe("readinessInWords", () => {
  const notReady = (...errors: { code: string; subject: string }[]) =>
    ({ errors, status: "not-ready" }) as unknown as RuntimeReadiness;

  it("names a broken trigger instead of blaming the workers", () => {
    const readiness = notReady({ code: "TRIGGER_CONFIGURATION_INVALID", subject: "chain" });
    expect(readinessInWords(readiness)).toBe("Trigger does not work");
    expect(readinessLabel(readiness)).toBe("Trigger invalid");
  });

  it("names the credentials a deployment waits for before blaming the workers", () => {
    expect(readinessInWords(notReady({ code: "SECRET_MISSING", subject: "VERIFY_SECRET" }))).toBe(
      "Needs secret VERIFY_SECRET",
    );
    expect(
      readinessInWords(
        notReady(
          { code: "RUNTIME_PROFILE_UNAVAILABLE", subject: "gpu" },
          { code: "SECRET_MISSING", subject: "A" },
          { code: "SECRET_MISSING", subject: "B" },
          { code: "CONNECTION_NOT_ACTIVE", subject: "gmail" },
        ),
      ),
    ).toBe("Needs secrets A, B and account gmail");
    expect(
      readinessInWords(notReady({ code: "RUNTIME_PROFILE_UNAVAILABLE", subject: "gpu" })),
    ).toBe("No worker can run it");
  });
});
