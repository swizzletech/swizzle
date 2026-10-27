import { describe, expect, it } from "vitest";

import { resolveApiUrl } from "./api.js";
import { mapApiErrorToAgentError } from "./errors.js";

// Profiles behind Caddy carry an /api prefix that a plain `new URL(path, base)` would drop.
describe("resolveApiUrl", () => {
  it.each([
    ["http://localhost:19826/api", "http://localhost:19826/api/deployments"],
    ["http://localhost:19826/api/", "http://localhost:19826/api/deployments"],
  ])("keeps the base path of %s", (base, expected) => {
    expect(resolveApiUrl(base, "/deployments").toString()).toBe(expected);
  });
});

describe("mapApiErrorToAgentError", () => {
  it("honors an explicit non-retryable platform error over the retryable 503 status", () => {
    const error = mapApiErrorToAgentError(
      503,
      {
        error: "ARTIFACT_STORAGE_NOT_WRITABLE",
        message: "Artifact volume ownership requires operator repair.",
        retryable: false,
      },
      "https://api.example.com/deployments",
    );

    expect(error.code).toBe("ARTIFACT_STORAGE_NOT_WRITABLE");
    expect(error.retryable).toBe(false);
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
  ])("never marks a %i token failure retryable", (status, code) => {
    const error = mapApiErrorToAgentError(
      status,
      { error: code, message: "bearer token" },
      "http://api.localhost:19826/runs",
    );

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
  });
});
