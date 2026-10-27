import { describe, expect, it } from "vitest";

import { ApiContactLog, contractChangeFailure } from "./api-signals.js";
import { createOutputRedactor } from "./output-redaction.js";

describe("ApiContactLog", () => {
  it("keeps one contact per host with its RFC 9745 and RFC 8594 notice, path redacted and query dropped", () => {
    const log = new ApiContactLog();
    log.record(
      {
        deprecation: "@1688169599",
        host: "API.Example.com",
        link: '<https://example.com/docs>; rel="help", <https://example.com/sunset>; rel="sunset"',
        path: "/v2/accounts/tok-123/transactions?page=2",
        status: 200,
        sunset: "Thu, 31 Dec 2026 23:59:59 GMT",
        timestamp: "2026-10-24T06:00:00.000Z",
        type: "api_contact",
      },
      "2026-10-24T06:00:01.000Z",
    );
    log.record(
      {
        host: "api.example.com",
        status: 503,
        timestamp: "2026-10-24T06:00:05.000Z",
        type: "api_contact",
      },
      "2026-10-24T06:00:06.000Z",
    );

    expect(log.observations(createOutputRedactor(["tok-123"]))).toEqual([
      {
        host: "api.example.com",
        lastContactAt: "2026-10-24T06:00:05.000Z",
        lastOkAt: "2026-10-24T06:00:00.000Z",
        lastStatus: 503,
        notice: {
          deprecatedAt: "2023-06-30T23:59:59.000Z",
          path: "/v2/accounts/[REDACTED]/transactions",
          sunsetAt: "2026-12-31T23:59:59.000Z",
          url: "https://example.com/sunset",
        },
      },
    ]);
  });

  it("reads `true` as deprecated now, and ignores `false` and dates a Date cannot hold", () => {
    const log = new ApiContactLog();
    const at = "2026-10-24T06:00:01.000Z";
    const answer = (host: string, headers: Record<string, string>) =>
      log.record({ host, status: 200, timestamp: at, type: "api_contact", ...headers }, at);
    answer("legacy.example.com", { deprecation: "true" });
    answer("not-deprecated.example.com", { deprecation: "false" });
    answer("far-future.example.com", { deprecation: "@8640000000001" });
    answer("sunset-only.example.com", {
      deprecation: "false",
      sunset: "Thu, 31 Dec 2026 23:59:59 GMT",
    });

    const notices = Object.fromEntries(
      log.observations(createOutputRedactor([])).map((contact) => [contact.host, contact.notice]),
    );
    expect(notices).toEqual({
      "far-future.example.com": null,
      "legacy.example.com": { deprecatedAt: at, path: null, sunsetAt: null, url: null },
      "not-deprecated.example.com": null,
      "sunset-only.example.com": {
        deprecatedAt: null,
        path: null,
        sunsetAt: "2026-12-31T23:59:59.000Z",
        url: null,
      },
    });
  });
});

describe("contractChangeFailure", () => {
  it("names the field the automation's parser reported, and nothing without the event", () => {
    const stderr = [
      "fetching deals",
      JSON.stringify({
        api: "api.hubapi.com",
        expected: "a number",
        field: "results[].properties.amount",
        got: "a string",
        type: "contract_changed",
      }),
    ].join("\n");

    expect(contractChangeFailure(stderr)).toEqual({
      code: "UPSTREAM_CONTRACT_CHANGED",
      message:
        "The API of api.hubapi.com changed: results[].properties.amount is a string, expected a number.",
    });
    expect(contractChangeFailure("Error: boom")).toEqual({});
  });
});
