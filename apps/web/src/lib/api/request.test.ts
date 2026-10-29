import { describe, expect, it } from "vitest";

import { publicApiUrl } from "./request";

describe("publicApiUrl", () => {
  it("names the CLI's default address for the packaged stack opened at localhost", () => {
    expect(publicApiUrl("/api", "http://localhost:19826", true)).toBe("http://api.localhost:19826");
  });

  it("keeps the dashboard's own /api on any other origin or in development", () => {
    expect(publicApiUrl("/api", "https://swizzle.example.com", true)).toBe(
      "https://swizzle.example.com/api",
    );
    expect(publicApiUrl("/api", "http://localhost:5173", false)).toBe("http://localhost:5173/api");
  });
});
