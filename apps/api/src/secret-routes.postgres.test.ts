import path from "node:path";

import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

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

describe("secret routes", () => {
  it("supports write-only secret CRUD and automation secret health inspection", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });
    const fixture = path.join(repoRoot, "packages/runtime/test-fixtures/requires-secret");

    // A version deploys once the secrets it declares are set.
    expect((await deployFixture(app, fixture, {}, { headers: owner })).json()).toMatchObject({
      error: "PLATFORM_REQUIRED_SECRETS_MISSING",
    });

    const setSecretResponse = await app.inject({
      headers: owner,
      method: "PUT",
      payload: { value: "super-secret-value" },
      url: "/secrets/REQUIRED_TOKEN",
    });
    expect(setSecretResponse.statusCode).toBe(200);
    expect(setSecretResponse.body).not.toContain("super-secret-value");
    expect(setSecretResponse.json()).toMatchObject({
      environment: "local",
      name: "REQUIRED_TOKEN",
      secretVersion: 1,
    });

    const inspectSecretResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/secrets/REQUIRED_TOKEN",
    });
    expect(inspectSecretResponse.statusCode).toBe(200);
    expect(inspectSecretResponse.body).not.toContain("super-secret-value");
    expect((await deployFixture(app, fixture, {}, { headers: owner })).statusCode).toBe(200);
    expect(inspectSecretResponse.json()).toMatchObject({
      name: "REQUIRED_TOKEN",
      secretVersion: 1,
    });

    const listSecretsResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/secrets",
    });
    expect(listSecretsResponse.statusCode).toBe(200);
    expect(listSecretsResponse.body).not.toContain("super-secret-value");
    expect(listSecretsResponse.json()).toEqual({
      environment: "local",
      secrets: [
        expect.objectContaining({
          name: "REQUIRED_TOKEN",
          right: "manage",
          secretVersion: 1,
        }),
      ],
    });

    const secretHealthResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/requires-secret",
    });
    expect(secretHealthResponse.statusCode).toBe(200);
    expect(secretHealthResponse.json()).toMatchObject({
      secretHealth: [
        {
          name: "REQUIRED_TOKEN",
          secretVersion: 1,
          state: "bound",
        },
      ],
    });

    const deleteSecretResponse = await app.inject({
      headers: owner,
      method: "DELETE",
      url: "/secrets/REQUIRED_TOKEN",
    });
    expect(deleteSecretResponse.statusCode).toBe(204);

    const deletedInspectResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/secrets/REQUIRED_TOKEN",
    });
    expect(deletedInspectResponse.statusCode).toBe(404);
    // Its deployment lost the secret with it, and one set again waits for the next deploy.
    const health = async () =>
      (
        await app.inject({
          headers: owner,
          method: "GET",
          url: "/automations/requires-secret/secrets",
        })
      ).json();
    expect(await health()).toEqual({
      automationName: "requires-secret",
      environment: "local",
      secrets: [expect.objectContaining({ name: "REQUIRED_TOKEN", state: "missing" })],
    });
    const setAgain = await app.inject({
      headers: owner,
      method: "PUT",
      payload: { value: "again" },
      url: "/secrets/REQUIRED_TOKEN",
    });
    expect(setAgain.statusCode).toBe(200);
    expect(await health()).toMatchObject({
      secrets: [expect.objectContaining({ name: "REQUIRED_TOKEN", state: "unbound" })],
    });

    await app.close();
  });

  it("warns when secret names are shared by active automations", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });
    await app.inject({
      headers: owner,
      method: "PUT",
      payload: { value: "false" },
      url: "/secrets/DRY_RUN",
    });

    const firstDeploy = await deployFixture(
      app,
      path.join(repoRoot, "packages/runtime/test-fixtures/secret-collision-a"),
      {},
      { headers: owner },
    );
    expect(firstDeploy.statusCode).toBe(200);
    expect(firstDeploy.json()).toMatchObject({
      automationName: "secret-collision-a",
      warnings: [],
    });

    const secondDeploy = await deployFixture(
      app,
      path.join(repoRoot, "packages/runtime/test-fixtures/secret-collision-b"),
      {},
      { headers: owner },
    );
    expect(secondDeploy.statusCode).toBe(200);
    expect(secondDeploy.json()).toMatchObject({
      automationName: "secret-collision-b",
      warnings: [expect.stringContaining("Secret DRY_RUN is also declared by secret-collision-a")],
    });

    const setSecretResponse = await app.inject({
      headers: owner,
      method: "PUT",
      payload: { value: "true" },
      url: "/secrets/DRY_RUN",
    });
    expect(setSecretResponse.statusCode).toBe(200);
    expect(setSecretResponse.json()).toMatchObject({
      name: "DRY_RUN",
      warnings: [expect.stringContaining("Secret DRY_RUN is also declared by secret-collision-a")],
    });
    expect(setSecretResponse.body).toContain("secret-collision-b");
    expect(setSecretResponse.body).not.toContain('"true"');

    await app.close();
  });
});
