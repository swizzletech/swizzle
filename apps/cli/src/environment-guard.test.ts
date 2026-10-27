import { describe, expect, it } from "vitest";

import { buildUnservedEnvironmentWarning, type EnvironmentLiveness } from "./environment-guard.js";

const environments: EnvironmentLiveness[] = [
  { name: "local", hasData: true, liveServices: [] },
  { name: "prod", hasData: true, liveServices: ["scheduler", "worker"] },
];

describe("buildUnservedEnvironmentWarning (deploy)", () => {
  it("warns and suggests an environment with a live scheduler", () => {
    const warning = buildUnservedEnvironmentWarning({
      mode: "deploy",
      environment: "local",
      environments,
    });
    expect(warning).toBe(
      'No live scheduler heartbeat for environment "local" on this instance, so its cron triggers will not fire. Environments with a live scheduler: prod. Deploy with -e prod if that was the target.',
    );
  });

  it("stays silent when the target environment has a live scheduler", () => {
    expect(
      buildUnservedEnvironmentWarning({ mode: "deploy", environment: "prod", environments }),
    ).toBeNull();
  });

  it("does not treat a live worker as a scheduler, since workers serve every environment", () => {
    const warning = buildUnservedEnvironmentWarning({
      mode: "deploy",
      environment: "local",
      environments: [{ name: "local", hasData: true, liveServices: ["worker"] }],
    });
    expect(warning).toBe(
      'No live scheduler heartbeat for environment "local" on this instance, so its cron triggers will not fire.',
    );
  });
});

describe("buildUnservedEnvironmentWarning (status)", () => {
  it("warns only when the target has data but another environment has a scheduler", () => {
    const warning = buildUnservedEnvironmentWarning({
      mode: "status",
      environment: "local",
      environments,
    });
    expect(warning).toContain("Environments with a live scheduler: prod");
  });

  it("stays silent when no scheduler runs anywhere (plain outage, not misdirection)", () => {
    expect(
      buildUnservedEnvironmentWarning({
        mode: "status",
        environment: "local",
        environments: [
          { name: "local", hasData: true, liveServices: [] },
          { name: "prod", hasData: true, liveServices: ["worker"] },
        ],
      }),
    ).toBeNull();
  });

  it("stays silent when the target environment has no data", () => {
    expect(
      buildUnservedEnvironmentWarning({
        mode: "status",
        environment: "local",
        environments: [
          { name: "local", hasData: false, liveServices: [] },
          { name: "prod", hasData: true, liveServices: ["scheduler"] },
        ],
      }),
    ).toBeNull();
  });
});
