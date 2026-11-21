import { describe, expect, it, vi } from "vitest";

import { apiRequest, resolveApiUrl } from "./api.js";
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
  it.each(["<!doctype html><html>Dashboard</html>", "{broken", "null", '"dashboard"'])(
    "rejects a successful non-API response with body %s",
    async (body) => {
      const fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      await expect(apiRequest("http://localhost/api/items")).rejects.toMatchObject({
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
        .mockResolvedValueOnce(Response.json({ rules: [] }))
        .mockResolvedValueOnce(
          Response.json({ error: "FORBIDDEN", message: "Token revoked" }, { status: 403 }),
        )
        .mockResolvedValueOnce(Response.json({ error: "NOT_FOUND" }, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    const url = "http://localhost/api/items";
    await expect(apiRequest(url)).resolves.toEqual({ rules: [] });
    await expect(apiRequest(url)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Token revoked",
      exitCode: 4,
    });
    await expect(apiRequest(url, { acceptNotFound: true })).resolves.toBeUndefined();
    await expect(apiRequest(url)).resolves.toBeUndefined();
  });

  it("keeps an HTML 502 retryable with the server-failure hint", async () => {
    const body = "<html>Bad Gateway</html>";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 502 })));
    await expect(apiRequest("http://localhost/api/items")).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message: body,
      exitCode: 5,
      retryable: true,
      hint: "The platform failed, not the request. Retry, or run `swizzle doctor` and read the API logs.",
      details: { httpStatus: 502 },
    });
  });

  it("accepts a non-JSON 404 when acceptNotFound is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>Dashboard</html>", { status: 404 })),
    );
    await expect(
      apiRequest("http://localhost/api/items", { acceptNotFound: true }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when a successful response has an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    await expect(apiRequest("http://localhost/api/items")).resolves.toBeUndefined();
  });
});
