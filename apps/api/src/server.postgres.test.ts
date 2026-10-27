import { chmod } from "node:fs/promises";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { testEnvironmentStore } from "../../../test/stores.js";

import { temporaryDirectory } from "../../../test/support.js";

import { deployFixture } from "../test/automations.js";

import { ownerHeaders } from "../test/people.js";

import { buildTestServer } from "../test/server-harness.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

const appRoot = path.resolve(sourceRoot, "..");

const repoRoot = path.resolve(appRoot, "../..");

let owner: { readonly authorization: string };

beforeEach(async () => {
  owner = await ownerHeaders();
});

describe("server", () => {
  it("serializes dates and buffers while hiding wait links in JSON answers", async () => {
    const platform = await testPlatform();
    const app = await buildTestServer({ platform });
    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );
    const trigger = await app.inject({ method: "POST", url: "/hello", payload: {} });
    const runId: string = trigger.json().runId;
    const run = await platform.getPlatformRun(runId);
    const token = `0b1e7c2a-5f3d-4c6b-9a8e-1d2f3a4b5c6d.Z2F0ZQ.${"s".repeat(43)}`;
    vi.spyOn(platform, "getPlatformRun").mockResolvedValue({
      ...run,
      result: {
        at: new Date("2026-10-26T00:00:00Z"),
        buf: Buffer.from("ab"),
        link: `/events/${token}`,
      },
    });
    const response = await app.inject({ headers: owner, method: "GET", url: `/runs/${runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      at: "2026-10-26T00:00:00.000Z",
      buf: { type: "Buffer", data: [97, 98] },
      link: "/events/[REDACTED]",
    });
    await app.close();
  });

  it("reports health with SWIZZLE_PLATFORM_VERSION preferred and its v prefix stripped", async () => {
    vi.stubEnv("SWIZZLE_PLATFORM_VERSION", "v0.11.0");
    vi.stubEnv("SWIZZLE_IMAGE_TAG", "v0.10.0");
    vi.stubEnv("SWIZZLE_VERSION", "v0.9.0");
    const app = await buildTestServer({
      platform: await testPlatform(),
    });
    const response = await app.inject({ headers: owner, method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "api", status: "ok", version: "0.11.0" });

    await app.close();
  });

  it("returns a clear 503 when the encryption key is missing for secret writes", async () => {
    const app = await buildTestServer({
      platform: await testPlatform(),
    });
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", undefined);

    const response = await app.inject({
      headers: owner,
      method: "PUT",
      payload: { value: "super-secret-value" },
      url: "/secrets/MISSING_KEY_SECRET",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "MISSING_ENCRYPTION_KEY",
    });

    await app.close();
  });

  it("serves a deployment and a request without an environment from the configured one", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ environment: "staging", platform });

    const deployed = await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );
    expect(deployed.statusCode).toBe(200);
    const webhook = await app.inject({
      headers: owner,
      method: "POST",
      url: "/hello",
      payload: { source: "test" },
    });
    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toMatchObject({ status: "queued" });

    await app.close();
  });

  it("lists and creates environment registry entries", async () => {
    const app = await buildTestServer({
      environment: "prod",
      environmentStore: await testEnvironmentStore([{ name: "staging" }]),
      platform: await testPlatform(),
    });

    const initial = await app.inject({ headers: owner, method: "GET", url: "/environments" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      defaultEnvironment: "prod",
      environments: [
        expect.objectContaining({ name: "prod", registered: false }),
        expect.objectContaining({ name: "staging", registered: true }),
      ],
    });

    const created = await app.inject({
      headers: owner,
      method: "POST",
      url: "/environments",
      payload: { displayName: "Production", name: "prod" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      displayName: "Production",
      name: "prod",
      registered: true,
    });

    const invalid = await app.inject({
      headers: owner,
      method: "POST",
      url: "/environments",
      payload: { name: "bad name" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "AUTOMATION_CONFIG_INVALID" });

    await app.close();
  });

  it("fails readiness with a typed non-retryable error for an unwritable artifact root", async () => {
    const artifactsDirectory = await temporaryDirectory("swizzle-api-artifacts-");
    await chmod(artifactsDirectory, 0o555);
    const app = await buildTestServer({
      platform: await testPlatform({ artifactsDirectory }),
    });

    try {
      const response = await app.inject({ headers: owner, method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        checks: {
          artifactStorage: {
            code: "ARTIFACT_STORAGE_NOT_WRITABLE",
            ok: false,
            target: artifactsDirectory,
          },
        },
        error: "ARTIFACT_STORAGE_NOT_WRITABLE",
        retryable: false,
        status: "not-ready",
      });

      const deployment = await deployFixture(
        app,
        path.join(repoRoot, "infra/examples/hello-webhook"),
        {},
        { headers: owner },
      );
      expect(deployment.statusCode).toBe(503);
      expect(deployment.json()).toMatchObject({
        error: "ARTIFACT_STORAGE_NOT_WRITABLE",
        retryable: false,
      });
    } finally {
      await app.close();
      await chmod(artifactsDirectory, 0o755);
    }
  });
});
