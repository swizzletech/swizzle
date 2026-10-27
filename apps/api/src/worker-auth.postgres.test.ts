import { DEFAULT_PROJECT_ID, type RegisteredWorker } from "@swizzle/db";
import { createPostgresWorkerRegistry } from "@swizzle/db/postgres";
import { expect, it, onTestFinished, vi } from "vitest";
import { testDatabase } from "../../../test/postgres.js";
import { testApiTokenStore } from "../../../test/stores.js";
import { testPeople } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

const identity: RegisteredWorker = {
  kind: "remote",
  capacity: 1,
  draining: false,
  id: "00000000-0000-4000-8000-000000000123",
  credentialGeneration: 1,
  name: "GPU",
  state: "online",
  services: [],
  profiles: ["gpu-home"],
  environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "staging" }],
  lastSeenAt: null,
  createdAt: "2026-10-25T00:00:00Z",
  tokenExpiresAt: "2027-01-25T00:00:00Z",
  runImageDisk: null,
  capabilities: null,
};

async function workerTokens() {
  await testDatabase().pool.query(
    "INSERT INTO workers (id, name, profiles, services, enrollment_expires_at) VALUES ($1, 'Worker', ARRAY['host-default'], ARRAY[]::text[], now()) ON CONFLICT DO NOTHING",
    [identity.id],
  );
  const tokens = testApiTokenStore();
  await tokens.createToken({
    holder: { kind: "worker", workerId: identity.id },
    issuedBy: null,
    name: "worker",
    scope: { role: "admin", environments: null, projectIds: null },
    plaintext: `swz_${"a".repeat(43)}`,
  });
  return tokens;
}

it("confines worker credentials to the worker protocol", async () => {
  // PostgreSQL transaction behavior is exercised by verify-workers.ts. Here the auth boundary
  // returns one live identity so the real HTTP policy must refuse control-plane access.
  const registry = createPostgresWorkerRegistry({ client: testDatabase() });
  vi.spyOn(registry, "authenticate").mockResolvedValue(identity);
  vi.spyOn(registry, "heartbeat").mockResolvedValue({
    ...identity,
    slotsInUse: 0,
    localLlm: null,
  });
  const tokens = await workerTokens();
  const app = await buildTestServer({
    workerRegistry: registry,
    apiTokenStore: tokens,
  });
  onTestFinished(() => app.close());
  const headers = { authorization: `Bearer swz_${"a".repeat(43)}` };
  const beat = await app.inject({
    method: "POST",
    url: "/worker/heartbeat",
    headers,
    payload: {},
  });
  expect(beat.statusCode).toBe(200);
  expect(beat.json().name).toBe("GPU");
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/worker/heartbeat",
        headers,
        payload: { profiles: ["stolen-group"] },
      })
    ).statusCode,
  ).toBe(400);
  for (const [method, url, payload] of [
    ["GET", "/workers", undefined],
    ["POST", "/workers/enrollments", {}],
    ["GET", "/secrets?environment=production", undefined],
    ["POST", "/projects", { name: "Owned", slug: "owned" }],
    ["GET", "/auth/identity", undefined],
    ["GET", "/environments", undefined],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    expect({ url, status: response.statusCode, code: response.json().code }).toEqual({
      url,
      status: 403,
      code: "ACCESS_DENIED",
    });
  }
  expect(
    (await app.inject({ method: "POST", url: "/worker/heartbeat", payload: {} })).statusCode,
  ).toBe(403);
  await tokens.revokeToken({ kind: "worker", workerId: identity.id }, "worker");
  expect(
    (await app.inject({ method: "POST", url: "/worker/heartbeat", headers, payload: {} }))
      .statusCode,
  ).toBe(403);
  expect((await app.inject({ method: "GET", url: "/environments", headers })).statusCode).toBe(403);
});

it("permits owner/admin enrollment but refuses member, narrowed owner and personal credentials on worker routes", async () => {
  const registry = createPostgresWorkerRegistry({ client: testDatabase() });
  const enrollment = {
    worker: { ...identity, state: "pending" as const },
    code: "one-use-code",
    expiresAt: "2026-10-25T00:10:00Z",
  };
  vi.spyOn(registry, "create").mockResolvedValue(enrollment);
  const apiTokenStore = testApiTokenStore();
  const people = testPeople();
  const app = await buildTestServer({ workerRegistry: registry, apiTokenStore, auth: people.auth });
  onTestFinished(() => app.close());
  const payload = {
    name: "GPU",
    services: ["local-llm"],
    profiles: ["gpu-home"],
    environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "staging" }],
  };
  for (const role of ["owner", "admin", "member"] as const) {
    const principal = await people.bearer(apiTokenStore, `${role}@worker.test`, role);
    const headers = { authorization: principal.authorization };
    const response = await app.inject({
      method: "POST",
      url: "/workers/enrollments",
      headers,
      payload,
    });
    expect(response.statusCode).toBe(role === "member" ? 403 : 200);
    if (role !== "member") expect(response.json().worker.name).toBe("GPU");
    expect(
      (await app.inject({ method: "POST", url: "/worker/heartbeat", headers, payload: {} }))
        .statusCode,
    ).toBe(403);
    if (role === "owner") {
      const narrowed = await apiTokenStore.createToken({
        holder: { kind: "person", userId: principal.userId },
        issuedBy: { id: principal.userId, name: "principal" },
        name: "narrowed",
        scope: { role: "editor", projectIds: [DEFAULT_PROJECT_ID], environments: ["staging"] },
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/workers/enrollments",
            headers: { authorization: `Bearer ${narrowed.token}` },
            payload,
          })
        ).statusCode,
      ).toBe(403);
    }
  }
});

it("keeps worker session queries strict after adding the shared environment validation", async () => {
  const registry = createPostgresWorkerRegistry({ client: testDatabase() });
  vi.spyOn(registry, "authenticate").mockResolvedValue(identity);
  vi.spyOn(registry, "session").mockResolvedValue(identity);
  const app = await buildTestServer({
    workerRegistry: registry,
    apiTokenStore: await workerTokens(),
  });
  onTestFinished(() => app.close());
  const headers = { authorization: `Bearer swz_${"a".repeat(43)}` };
  const url = `/worker/session?profile=gpu-home&projectId=${DEFAULT_PROJECT_ID}&environment=staging`;
  const allowed = await app.inject({ method: "GET", url, headers });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().worker.name).toBe("GPU");
  const unexpected = await app.inject({ method: "GET", url: `${url}&unexpected=value`, headers });
  expect(unexpected.statusCode).toBe(400);
  expect(unexpected.json().code).toBe("FST_ERR_VALIDATION");
});

it("accepts a configured local identity only on the private worker listener, without enrollment or administration routes", async () => {
  const { buildLocalWorkerServer } = await import("./local-worker-server.js");
  const registry = createPostgresWorkerRegistry({ client: testDatabase() });
  const local: RegisteredWorker = { ...identity, kind: "local", name: "Local worker" };
  const authenticate = vi.spyOn(registry, "authenticate").mockResolvedValue(local);
  const { dispatch } = await import("../test/worker-dispatch.js");
  const tokens = await workerTokens();
  const privateApp = buildLocalWorkerServer(dispatch, registry, local.id, tokens);
  const publicApp = await buildTestServer({
    workerRegistry: registry,
    dispatch,
    apiTokenStore: tokens,
  });
  onTestFinished(async () => {
    await privateApp.close();
    await publicApp.close();
  });
  const headers = { authorization: `Bearer swz_${"a".repeat(43)}` };
  const accepted = await privateApp.inject({
    method: "POST",
    url: "/worker/pull",
    headers,
    payload: {},
  });
  expect({ status: accepted.statusCode, body: accepted.json() }).toEqual({
    status: 200,
    body: { assignment: null },
  });
  for (const url of ["/worker/pull", "/workers/enrollments"]) {
    const refused = await publicApp.inject({ method: "POST", url, headers, payload: {} });
    expect({ status: refused.statusCode, code: refused.json().code }).toEqual({
      status: 403,
      code: "WORKER_FORBIDDEN",
    });
  }
  // Enrollment is public and uses its single-use code, so a bearer grants no authority there.
  const missingCode = await publicApp.inject({
    method: "POST",
    url: "/worker/enroll",
    headers,
    payload: {},
  });
  expect({ status: missingCode.statusCode, code: missingCode.json().code }).toEqual({
    status: 400,
    code: "FST_ERR_VALIDATION",
  });
  for (const url of ["/worker/enroll", "/workers/enrollments"]) {
    expect(
      (await privateApp.inject({ method: "POST", url, headers, payload: {} })).statusCode,
    ).toBe(404);
  }
  authenticate.mockResolvedValue({ ...local, id: "00000000-0000-4000-8000-000000000099" });
  expect(
    (await privateApp.inject({ method: "POST", url: "/worker/pull", headers, payload: {} }))
      .statusCode,
  ).toBe(403);
  authenticate.mockResolvedValue(identity);
  expect(
    (await privateApp.inject({ method: "POST", url: "/worker/pull", headers, payload: {} }))
      .statusCode,
  ).toBe(403);
  const remote = await publicApp.inject({
    method: "POST",
    url: "/worker/pull",
    headers,
    payload: {},
  });
  expect({ status: remote.statusCode, body: remote.json() }).toEqual({
    status: 200,
    body: { assignment: null },
  });
});
