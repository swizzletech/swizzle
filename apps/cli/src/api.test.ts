import { describe, expect, it, vi } from "vitest";

import { apiRequest, noContent, resolveApiUrl, whenFound } from "./api.js";
import { responses } from "./api-responses.js";
import { mapApiErrorToAgentError } from "./errors.js";

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

describe("apiRequest response parsing", () => {
  it.each(["AUTH_RATE_LIMITED", "DEPLOYMENT_UPLOAD_RATE_LIMITED", "WEBHOOK_RATE_LIMITED"])(
    "reports the retry delay from a %s response",
    async (error) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            Response.json(
              { error, details: { limit: 3 } },
              { status: 429, headers: { "Retry-After": "17" } },
            ),
          ),
      );
      await expect(
        apiRequest("http://localhost/api/deployments", responses.deployments),
      ).rejects.toMatchObject({
        code: error,
        details: { httpStatus: 429, limit: 3, retryAfterSeconds: 17 },
        exitCode: 7,
        hint: "Wait 17 seconds, then rerun the command.",
        retryable: true,
      });
    },
  );

  it("offers wait guidance when a rate-limited response omits Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "DEPLOYMENT_UPLOAD_RATE_LIMITED" }, { status: 429 }),
        ),
    );
    await expect(
      apiRequest("http://localhost/api/deployments", responses.deployments),
    ).rejects.toMatchObject({
      details: { httpStatus: 429 },
      hint: "Wait for the rate limit to reset, then rerun the command.",
    });
  });

  it.each(["<!doctype html><html>Dashboard</html>", "{broken", "null", '"dashboard"'])(
    "rejects a successful non-API response with body %s",
    async (body) => {
      const fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      await expect(
        apiRequest("http://localhost/api/items", responses.notificationRules),
      ).rejects.toMatchObject({
        code: "INVALID_API_RESPONSE",
        exitCode: 5,
        retryable: false,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves JSON data, API errors, accepted not-found and no-content responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ environment: "staging", rules: [] }))
        .mockResolvedValueOnce(
          Response.json({ error: "FORBIDDEN", message: "Token revoked" }, { status: 403 }),
        )
        .mockResolvedValueOnce(Response.json({ error: "NOT_FOUND" }, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    const url = "http://localhost/api/items";
    await expect(apiRequest(url, responses.notificationRules)).resolves.toEqual({
      environment: "staging",
      rules: [],
    });
    await expect(apiRequest(url, responses.notificationRules)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Token revoked",
      exitCode: 4,
    });
    await expect(apiRequest(url, whenFound(responses.notificationRules))).resolves.toBeUndefined();
    await expect(apiRequest(url, noContent)).resolves.toBeUndefined();
  });

  it("keeps an HTML 502 retryable with the server-failure hint", async () => {
    const body = "<html>Bad Gateway</html>";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 502 })));
    await expect(
      apiRequest("http://localhost/api/items", responses.notificationRules),
    ).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message: body,
      exitCode: 5,
      retryable: true,
      hint: "The platform failed, not the request. Retry, or run `swizzle doctor` and read the API logs.",
      details: { httpStatus: 502 },
    });
  });

  it("accepts a non-JSON 404 when the endpoint accepts not-found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>Dashboard</html>", { status: 404 })),
    );
    await expect(
      apiRequest("http://localhost/api/items", whenFound(responses.notificationRules)),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when a bodyless endpoint returns an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    await expect(apiRequest("http://localhost/api/items", noContent)).resolves.toBeUndefined();
  });
});
