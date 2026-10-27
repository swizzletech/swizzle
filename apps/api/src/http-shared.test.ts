import { describe, expect, it } from "vitest";

import { getAllowedOrigins } from "./http-shared.js";

describe("allowed browser origins", () => {
  it("uses explicit CORS origins as an override", () => {
    expect(
      getAllowedOrigins({
        SWIZZLE_CORS_ORIGINS: " https://one.example , https://two.example ",
        SWIZZLE_DASHBOARD_ORIGIN: "https://dashboard.example",
      }),
    ).toEqual(["https://one.example", "https://two.example"]);
  });

  it("allows only the dashboard origin when the override is blank", () => {
    expect(
      getAllowedOrigins({
        SWIZZLE_CORS_ORIGINS: "  ",
        SWIZZLE_DASHBOARD_ORIGIN: "https://swizzle.example.com",
      }),
    ).toEqual(["https://swizzle.example.com"]);
  });

  it("allows no origin when neither is configured", () => {
    expect(getAllowedOrigins({ NODE_ENV: "development" })).toEqual([]);
  });
});
