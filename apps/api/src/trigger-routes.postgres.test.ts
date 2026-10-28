import path from "node:path";

import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

import { createAutomationFixture, deployFixture } from "../test/automations.js";
import { DASHBOARD_ORIGIN, testBrowser } from "../test/browser.js";

import { ownerHeaders } from "../test/people.js";

import { buildTestServer } from "../test/server-harness.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

const appRoot = path.resolve(sourceRoot, "..");

const repoRoot = path.resolve(appRoot, "../..");

let owner: { readonly authorization: string };

beforeEach(async () => {
  owner = await ownerHeaders();
});

describe("trigger routes", () => {
  it.each(["/payload-schema", "/automations/webhook-payload-schema/runs"])(
    "rejects invalid payloads before enqueue through %s",
    async (url) => {
      const stateDirectory = await temporaryDirectory("swizzle-api-");

      const platform = await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      });
      const app = await buildTestServer({ platform });

      await deployFixture(
        app,
        path.join(repoRoot, "packages/runtime/test-fixtures/webhook-payload-schema"),
        {},
        { headers: owner },
      );

      const rejected = await app.inject({
        headers: owner,
        method: "POST",
        payload: { amount: 42 },
        url,
      });

      expect(rejected.statusCode).toBe(422);
      expect(rejected.json()).toMatchObject({
        details: {
          validationErrors: [
            expect.objectContaining({
              keyword: "required",
            }),
          ],
        },
        error: "WEBHOOK_PAYLOAD_INVALID",
      });

      const accepted = await app.inject({
        headers: owner,
        method: "POST",
        payload: { amount: 42, event: "invoice.created" },
        url,
      });

      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({
        status: "queued",
      });

      await app.close();
    },
  );

  it("rejects webhook triggers before enqueue once a bound secret is deleted", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const app = await buildTestServer({
      platform: await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      }),
    });

    await app.inject({
      headers: owner,
      method: "PUT",
      payload: { value: "v" },
      url: "/secrets/DECLARED_SECRET",
    });
    await deployFixture(
      app,
      path.join(repoRoot, "packages/runtime/test-fixtures/platform-env-snapshot"),
      {},
      { headers: owner },
    );
    await app.inject({ headers: owner, method: "DELETE", url: "/secrets/DECLARED_SECRET" });

    const triggerResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: { source: "missing-secret" },
      url: "/automations/platform-env-snapshot/runs",
    });

    expect(triggerResponse.statusCode).toBe(409);
    expect(triggerResponse.json()).toMatchObject({
      details: {
        missingSecrets: ["DECLARED_SECRET"],
      },
      error: "PLATFORM_REQUIRED_SECRETS_MISSING",
    });

    await app.close();
  });

  it("fires cron automations through the explicit cron trigger route", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });

    await deployFixture(
      app,
      path.join(repoRoot, "packages/runtime/test-fixtures/cron-success"),
      {},
      { headers: owner },
    );

    const triggerResponse = await app.inject({
      headers: owner,
      method: "POST",
      url: "/automations/cron-success/runs",
    });

    expect(triggerResponse.statusCode).toBe(200);
    expect(triggerResponse.json()).toMatchObject({ status: "queued" });

    await app.close();
  });

  it("supports pause and resume through the trigger control endpoints", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });

    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );

    const pauseResponse = await app.inject({
      headers: owner,
      method: "POST",
      url: "/automations/hello-webhook/trigger/pause",
    });
    expect(pauseResponse.statusCode).toBe(200);
    expect(pauseResponse.json()).toMatchObject({
      status: "paused",
    });

    // A paused trigger is indistinguishable from a nonexistent one on the public
    // ingress: the external caller gets the opaque 404 and no run is created. The
    // "paused" reason is only visible to operators via the trigger audit.
    const pausedTriggerResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: { source: "paused" },
      url: "/hooks/hello",
    });
    expect(pausedTriggerResponse.statusCode).toBe(404);
    expect(pausedTriggerResponse.json()).toMatchObject({
      code: "WEBHOOK_NOT_AVAILABLE",
      error: "WEBHOOK_NOT_AVAILABLE",
    });
    expect(JSON.stringify(pausedTriggerResponse.json())).not.toContain("PAUSED");

    const resumeResponse = await app.inject({
      headers: owner,
      method: "POST",
      url: "/automations/hello-webhook/trigger/resume",
    });
    expect(resumeResponse.statusCode).toBe(200);
    expect(resumeResponse.json()).toMatchObject({
      status: "active",
    });

    const resumedTriggerResponse = await app.inject({
      headers: owner,
      method: "POST",
      payload: { source: "resumed" },
      url: "/hooks/hello",
    });
    expect(resumedTriggerResponse.statusCode).toBe(200);

    const auditResponse = await app.inject({
      headers: owner,
      method: "GET",
      url: "/automations/hello-webhook/trigger/audit",
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(
      auditResponse
        .json()
        .map((event: { change: { eventType: string } }) => event.change.eventType),
    ).toEqual(["trigger_paused", "webhook_rejected", "trigger_resumed"]);

    await app.close();
  });

  it("rejects webhook path collisions on deploy", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const app = await buildTestServer({
      platform: await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      }),
    });

    await deployFixture(
      app,
      path.join(repoRoot, "infra/examples/hello-webhook"),
      {},
      { headers: owner },
    );

    const collisionResponse = await deployFixture(
      app,
      path.join(repoRoot, "packages/runtime/test-fixtures/hello-webhook-collision"),
      {},
      { headers: owner },
    );

    expect(collisionResponse.statusCode).toBe(409);
    expect(collisionResponse.json()).toMatchObject({
      error: "TRIGGER_WEBHOOK_PATH_CONFLICT",
    });

    await app.close();
  });

  it("answers a webhook whose path names an API route under /hooks, and leaves the route alone", async () => {
    vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", DASHBOARD_ORIGIN);
    const app = await buildTestServer({ platform: await testPlatform() });
    const deployed = await deployFixture(
      app,
      await createAutomationFixture({
        mainJs: "console.log('{}');",
        name: "sign-in-hook",
        path: "/hooks/auth/sign-in/email",
      }),
      {},
      { headers: owner },
    );
    expect(deployed.statusCode).toBe(200);
    expect(deployed.json().webhookUrl).toMatch(/\/hooks\/auth\/sign-in\/email\?environment=/u);

    const hook = await app.inject({
      method: "POST",
      payload: {},
      url: "/hooks/auth/sign-in/email",
    });
    expect(hook.statusCode).toBe(200);
    expect(hook.json()).toMatchObject({ status: "queued" });

    // Sign-in itself still answers: an empty body reaches the auth handler and is refused there.
    const signIn = await testBrowser(app).send("POST", "/auth/sign-in/email", {});
    expect(signIn.statusCode).toBe(400);
    expect(signIn.json()).toMatchObject({ error: "AUTH_REQUEST_INVALID" });

    await app.close();
  });
});
