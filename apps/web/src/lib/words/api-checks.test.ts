import { describe, expect, it } from "vitest";

import { apiCheckHandoff, apiCheckRunsInWords, apiSunsetHandoff } from "./api-checks";

const NOW = new Date("2026-10-23T12:00:00.000Z");

describe("API check handoffs", () => {
  const automation = { automationName: "crm-export", automationSlug: "crm-export" };

  it("carries the latest and the last green check output, and reads no older success as unaffected", () => {
    const item: Parameters<typeof apiCheckHandoff>[0] = {
      automation,
      change: { api: "api.hubapi.com", expected: "number", field: "amount", got: "string" },
      check: {
        consecutiveFailures: 2,
        deploymentId: "3f2a91c0-0000-4000-8000-000000000000",
        entrypoint: "check.ts",
        everyMs: 7 * 86_400_000,
        failingSince: "2026-10-22T08:00:00.000Z",
        lastCheckedAt: "2026-10-23T08:00:00.000Z",
        lastExitCode: 1,
        lastGreenAt: "2026-10-15T08:00:00.000Z",
        lastGreenOutput: '{"ok":true,"checked":["GET /crm/v3/objects/deals"]}',
        lastGreenReport: { ok: true, checked: ["GET /crm/v3/objects/deals"], change: null },
        lastReport: {
          ok: false,
          checked: [],
          change: { api: "api.hubapi.com", expected: "number", field: "amount", got: "string" },
        },
        lastOutput: '{"ok":false,"field":"amount","expected":"number","got":"string"}',
        lastStderrTail: null,
        lastWarning: null,
        nextCheckAt: "2026-10-30T08:00:00.000Z",
        status: "drift",
      },
      kind: "api-check",
      latestRun: { queuedAt: "2026-10-21T06:00:00.000Z", status: "succeeded" },
    };

    expect(apiCheckHandoff(item)).toBe(
      [
        "crm-export's API check fails since 2026-10-22 08:00 UTC (2 checks in a row). Its last run succeeded at 2026-10-21 06:00 UTC, before the check started failing; no run finished since.",
        "The check is check.ts in deployment 3f2a91c0, every 7d and after each deploy, against api.hubapi.com.",
        "Latest check, 2026-10-23 08:00 UTC, exit 1:",
        '{"ok":false,"field":"amount","expected":"number","got":"string"}',
        "Last green check, 2026-10-15 08:00 UTC, exit 0:",
        '{"ok":true,"checked":["GET /crm/v3/objects/deals"]}',
        "Compare the two outputs, then update the response parsing that the automation and check.ts share to the new shape.",
        "Reproduce with `swizzle run --check .`, run the automation locally with `swizzle run .` and redeploy with `swizzle apply .`.",
      ].join("\n"),
    );
    expect(apiCheckRunsInWords(item)).toBeNull();
    expect(
      apiCheckRunsInWords({
        ...item,
        latestRun: { queuedAt: "2026-10-23T06:00:00.000Z", status: "succeeded" },
      }),
    ).toBe("its runs still succeed");
  });

  it("names the retirement dates, where the headers came, the notice and why checks are off", () => {
    expect(
      apiSunsetHandoff(
        {
          apiCheck: { mode: "off", reason: "Paid per call; the monthly run is the test." },
          automation: { automationName: "bank-sync", automationSlug: "bank-sync" },
          contact: {
            deprecatedAt: "2026-10-01T00:00:00.000Z",
            host: "api.example-bank.de",
            lastContactAt: "2026-10-23T06:00:00.000Z",
            lastOkAt: "2026-10-23T06:00:00.000Z",
            lastStatus: 200,
            noticePath: "/v2/accounts/[REDACTED]/transactions",
            noticeRuns: 14,
            noticeSeenAt: "2026-10-23T06:00:00.000Z",
            noticeUrl: "https://developer.example-bank.de/sunset/v2",
            sunsetAt: "2026-12-31T00:00:00.000Z",
          },
          kind: "api-sunset",
        },
        NOW,
      ),
    ).toBe(
      [
        "bank-sync calls api.example-bank.de, which announced its retirement: deprecated since 2026-10-01, sunset on 2026-12-31 (in 69 days). The headers came in 14 runs and checks, the latest at 2026-10-23 06:00 UTC, on /v2/accounts/[REDACTED]/transactions.",
        "The provider's notice: https://developer.example-bank.de/sunset/v2",
        'API checks are off for bank-sync: "Paid per call; the monthly run is the test."',
        "Read the notice, move the calls to the successor API before 2026-12-31, run the automation locally with `swizzle run .`, and redeploy with `swizzle apply .`.",
      ].join("\n"),
    );
  });
});
