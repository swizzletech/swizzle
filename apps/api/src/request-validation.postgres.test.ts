import { ROUTE_ACCESS, type RouteAccess } from "@swizzle/runtime/http-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testAuth } from "../../../test/stores.js";
import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";
import { ownerHeaders } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

let owner: { readonly authorization: string };
beforeEach(async () => {
  vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  owner = await ownerHeaders();
});

const UNKNOWN_RUN = "00000000-0000-4000-8000-000000000000";

// Requests whose shape PostgreSQL or a handler cannot take answer a fixed 400 before any lookup.
describe("request validation", () => {
  it("names an invalid notification request independently of automation configuration", async () => {
    const app = await buildTestServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/notifications/rules",
        headers: owner,
        payload: { eventType: "dead-lettered" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: "REQUEST_INVALID",
        error: "REQUEST_INVALID",
        message: "chatId is required.",
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["GET", "/runs/not-a-uuid", undefined],
    ["GET", "/runs/'%20OR%201=1--", undefined],
    ["GET", "/automations/%00", undefined],
    ["GET", `/runs/${UNKNOWN_RUN}/logs?after=abc`, undefined],
    ["GET", "/secrets?environment=%00", undefined],
    ["PUT", "/secrets/OK_NAME", { value: { nested: true } }],
    ["PUT", "/secrets/bad%20name", { value: "x" }],
    ["POST", "/automation-folders", { name: "a\u0000b" }],
    ["POST", "/automations/hello/rollback", { targetDeploymentId: "nonexistent" }],
    ["POST", "/automations/hello/rollback", { targetDeploymentId: true }],
    // JSON bodies keep their types: no scalar becomes a string, no value becomes an array.
    ["PUT", "/secrets/OK_NAME", { value: 123 }],
    ["PUT", "/secrets/OK_NAME", { value: true }],
    [
      "POST",
      "/connections/github/authorize",
      { clientId: "id", clientSecret: "secret", provider: "github", scopes: "repo" },
    ],
    ["POST", "/notifications/rules", { chatId: "1", eventType: "dead-lettered", threshold: "5" }],
    ["GET", "/dashboard/runs?limit=many", undefined],
    ["GET", "/dashboard/runs?approvalOnly=yes", undefined],
  ] as const)("answers 400 to %s %s", async (method, url, payload) => {
    const app = await buildTestServer({ platform: await testPlatform() });

    const response = await app.inject({
      headers: owner,
      method,
      url,
      ...(payload ? { payload } : {}),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

// An unchecked id reaches PostgreSQL and fails the request, so UUID validation must happen at
// the route boundary. The auth fixture uses the production adapter.
describe("an id no route checked", () => {
  it("fails the route as PostgreSQL fails it", async () => {
    const auth = testAuth();
    const table = ROUTE_ACCESS as Record<string, RouteAccess>;
    table["GET /unchecked-person"] = "public";
    try {
      const app = await buildTestServer({ auth });
      app.get("/unchecked-person", async (request) => ({
        person: await auth.findPerson((request.query as { id: string }).id),
      }));

      const known = await app.inject({ method: "GET", url: `/unchecked-person?id=${UNKNOWN_RUN}` });
      expect(known.json()).toEqual({ person: null });
      const unchecked = await app.inject({
        method: "GET",
        url: "/unchecked-person?id=nobody@office.test",
      });
      expect(unchecked.statusCode).toBe(500);
      await app.close();
    } finally {
      delete table["GET /unchecked-person"];
    }
  });
});
