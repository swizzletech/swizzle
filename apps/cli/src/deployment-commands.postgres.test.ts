import { createHmac } from "node:crypto";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";

import { loadAutomationDefinition } from "@swizzle/runtime";
import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { testEnvironmentStore } from "../../../test/stores.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

import {
  buildTestServer,
  closeServer,
  createBufferIO,
  createDashboardStub,
  fixturesRoot,
  listenOnRandomPort,
  OWNER_TOKEN,
  repoRoot,
  useCliTestEnvironment,
} from "../test/cli-harness.js";

import { runCli } from "./main.js";

// Commands that talk to an API instance, run against a real in-process API server with PostgreSQL stores.
useCliTestEnvironment();

describe("deployment commands", () => {
  it("previews the same field changes apply prints and keeps the active version until apply", async () => {
    const directory = await temporaryDirectory("swizzle-cli-deployment-changes-");
    await cp(path.join(repoRoot, "infra/examples/hello-webhook"), directory, { recursive: true });
    const platform = await testPlatform({
      artifactsDirectory: await temporaryDirectory("swizzle-cli-change-artifacts-"),
    });
    const app = await buildTestServer({ platform });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const apply = async (...flags: string[]) => {
      const io = createBufferIO();
      expect(await runCli(["apply", directory, "--api-url", address, "--json", ...flags], io)).toBe(
        0,
      );
      return JSON.parse(io.stdoutText);
    };
    try {
      expect((await apply()).deployment).toMatchObject({ action: "create", seq: 1 });
      const config = path.join(directory, "config.yaml");
      await writeFile(
        config,
        (await readFile(config, "utf8"))
          .replace("version: 1.0.0", "version: 1.1.0")
          .replace("timeout: 30s", "timeout: 20s"),
      );
      const preview = await apply("--dry-run");
      expect(preview).toMatchObject({
        action: "update",
        changes: expect.arrayContaining([
          { field: "version", from: "1.0.0", to: "1.1.0" },
          {
            field: "config",
            from: expect.stringContaining('"timeout":"30s"'),
            to: expect.stringContaining('"timeout":"20s"'),
          },
        ]),
      });
      expect((await platform.getAutomationDeployment("hello-webhook", "local")).seq).toBe(1);
      const validated = createBufferIO();
      expect(await runCli(["validate", directory, "--api-url", address, "--json"], validated)).toBe(
        0,
      );
      expect(JSON.parse(validated.stdoutText).deployment).toEqual({
        action: "update",
        changes: preview.changes,
      });
      const applied = await apply();
      expect(applied.deployment).toMatchObject({ action: "update", seq: 2 });
      expect(applied.changes).toEqual(preview.changes);
      expect((await apply()).deployment).toMatchObject({
        action: "noop (already deployed)",
        seq: 2,
      });
    } finally {
      await app.close();
    }
  });

  it("lists secret collision warnings from apply in its output", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-cli-collisions-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const app = await buildTestServer({ platform });
    await app.inject({
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      method: "PUT",
      payload: { value: "false" },
      url: "/secrets/DRY_RUN",
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const firstIo = createBufferIO();
      let exitCode = await runCli(
        ["apply", path.join(fixturesRoot, "secret-collision-a"), "--json", "--api-url", address],
        firstIo,
      );
      expect(exitCode).toBe(0);

      const secondIo = createBufferIO();
      exitCode = await runCli(
        ["apply", path.join(fixturesRoot, "secret-collision-b"), "--json", "--api-url", address],
        secondIo,
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(secondIo.stdoutText)).toMatchObject({
        warnings: expect.arrayContaining([
          expect.stringContaining("Secret DRY_RUN is also declared by secret-collision-a"),
        ]),
      });
    } finally {
      await app.close();
    }
  });

  // Behind a proxy the API knows where senders reach it only from SWIZZLE_PUBLIC_URL.
  it.each(["", "/api", "/platform/api"])(
    "prints working apply webhook URLs through public URL path %s",
    async (prefix) => {
      const stateDirectory = await temporaryDirectory("swizzle-cli-webhook-url-");
      const platform = await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      });
      const app = await buildTestServer({ environment: "staging", platform });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const proxy = createServer((incoming, outgoing) => {
        if (!incoming.url?.startsWith(`${prefix}/`)) {
          outgoing.writeHead(405).end();
          return;
        }
        const upstream = request(
          new URL(incoming.url.slice(prefix.length), address),
          {
            method: incoming.method,
            headers: incoming.headers,
          },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
          },
        );
        incoming.pipe(upstream);
      });
      const profileUrl = `${await listenOnRandomPort(proxy)}${prefix}`;

      try {
        vi.stubEnv("PROXY_TOKEN", OWNER_TOKEN);
        vi.stubEnv("SWIZZLE_PUBLIC_URL", profileUrl);
        const profile = createBufferIO();
        expect(
          await runCli(
            [
              "profile",
              "add",
              "proxy",
              "--url",
              profileUrl,
              "--token-env",
              "PROXY_TOKEN",
              "--env",
              "production",
              "--default",
            ],
            profile,
          ),
        ).toBe(0);
        const applied = createBufferIO();
        expect(
          await runCli(
            ["apply", path.join(repoRoot, "infra/examples/hello-webhook"), "--json"],
            applied,
          ),
        ).toBe(0);
        const applyOutput = JSON.parse(applied.stdoutText);
        const { webhookUrl } = applyOutput;
        expect(webhookUrl).toBe(`${profileUrl}/hello?environment=production`);
        const webhook = await fetch(webhookUrl, { body: "{}", method: "POST" });
        expect(webhook.status).toBe(200);
        expect(await webhook.json()).toMatchObject({ status: "queued" });
        expect(applyOutput.warnings ?? []).toEqual([]);
      } finally {
        await closeServer(proxy);
        await app.close();
      }
    },
  );

  it("deploys a scaffolded webhook at an unguessable path that only a signed request starts", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-cli-signed-scaffold-");
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const app = await buildTestServer({
      platform: await testPlatform({ artifactsDirectory: path.join(stateDirectory, "artifacts") }),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const directory = path.join(stateDirectory, "office-hook");

    try {
      expect(await runCli(["init", directory, "--json"], createBufferIO())).toBe(0);
      const { config } = await loadAutomationDefinition(directory);
      const trigger = config.trigger.type === "webhook" ? config.trigger : undefined;
      expect(trigger?.path).toMatch(/^\/hooks\/office-hook-[0-9a-f]{24}$/);
      expect(trigger?.signature).toMatchObject({
        header: "x-swizzle-signature",
        prefix: "sha256=",
        secret: "OFFICE_HOOK_SIGNING_SECRET",
      });

      const key = "a-random-signing-key";
      vi.stubEnv("SIGNING_KEY", key);
      const secret = ["secret", "set", "OFFICE_HOOK_SIGNING_SECRET", "--value-env", "SIGNING_KEY"];
      expect(await runCli([...secret, "--api-url", address], createBufferIO())).toBe(0);
      const applied = createBufferIO();
      expect(await runCli(["apply", directory, "--json", "--api-url", address], applied)).toBe(0);
      const { webhookUrl } = JSON.parse(applied.stdoutText);

      const body = JSON.stringify({ event: "contact.created" });
      const unsigned = await fetch(webhookUrl, { body, method: "POST" });
      expect(unsigned.status).toBe(404);
      const signature = `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
      const signed = await fetch(webhookUrl, {
        body,
        headers: { "content-type": "application/json", "x-swizzle-signature": signature },
        method: "POST",
      });
      expect(signed.status).toBe(200);
      expect(await signed.json()).toMatchObject({ status: "queued" });
    } finally {
      await app.close();
    }
  });

  it("warns when apply puts a cron automation where no scheduler fires it, and only then", async () => {
    vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
    const stateDirectory = await temporaryDirectory("swizzle-cli-deploy-guard-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    // The isolated environment store reports no live services, so no scheduler serves staging.
    const app = await buildTestServer({
      platform,
      environment: "staging",
      environmentStore: await testEnvironmentStore([{ name: "staging" }]),
    });
    let environmentGets = 0;
    app.addHook("onRequest", async (request) => {
      if (request.method === "GET" && request.url === "/environments") environmentGets++;
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const apply = async (automationDirectory: string) => {
      environmentGets = 0;
      const io = createBufferIO();
      const exitCode = await runCli(
        ["apply", automationDirectory, "-e", "staging", "--json", "--api-url", address],
        io,
      );
      expect(exitCode).toBe(0);
      expect(environmentGets).toBe(1);
      expect(io.stderrText).toBe("");
      return JSON.parse(io.stdoutText) as { readonly warnings?: readonly string[] };
    };

    try {
      const cron = await apply(path.join(fixturesRoot, "cron-success"));
      expect(cron.warnings).toEqual([
        expect.stringContaining('No live scheduler heartbeat for environment "staging"'),
      ]);
      const webhook = await apply(path.join(repoRoot, "infra/examples/hello-webhook"));
      expect(webhook.warnings ?? []).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("deletes a paused automation through the API", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-cli-delete-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({
      platform,
      dashboard: createDashboardStub("hello-webhook"),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      });

      const cli = async (...args: string[]) => {
        const io = createBufferIO();
        const exitCode = await runCli([...args, "--json", "--api-url", address], io);
        return { exitCode, json: JSON.parse(io.stdoutText) };
      };
      const unconfirmed = await cli("delete", "hello-webhook");
      expect(unconfirmed.exitCode).toBe(2);
      expect(unconfirmed.json).toMatchObject({
        code: "CONFIRMATION_REQUIRED",
        help: [expect.stringContaining("swizzle delete hello-webhook -e local --yes")],
      });
      const unpaused = await cli("delete", "hello-webhook", "--yes");
      expect(unpaused.exitCode).toBe(8);
      expect(unpaused.json.code).toBe("AUTOMATION_NOT_PAUSED");

      await platform.pauseAutomationTrigger("hello-webhook", "local");

      const deleted = await cli("delete", "hello-webhook", "--yes");
      expect(deleted.exitCode).toBe(0);
      expect(deleted.json).toMatchObject({
        automation: "hello-webhook",
        state: "deleted",
        artifactsRemoved: true,
        deleted: { deployments: 1, runs: 0 },
        keptAuditEvents: expect.any(Number),
      });
      expect((await cli("delete", "hello-webhook", "--yes")).json).toEqual({
        automation: "hello-webhook",
        environment: "local",
        state: "already absent (no-op)",
      });
    } finally {
      await app.close();
    }
  });

  it("refuses fuzzy name matches on destructive commands", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-cli-fuzzy-guard-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({
      platform,
      dashboard: createDashboardStub("hello-webhook"),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const io = createBufferIO();
      const exitCode = await runCli(
        ["delete", "hello", "--yes", "--json", "--api-url", address],
        io,
      );
      expect(exitCode).toBe(2);
      expect(JSON.parse(io.stdoutText)).toMatchObject({
        code: "EXACT_NAME_REQUIRED",
        details: { closestMatch: "hello-webhook" },
      });
    } finally {
      await app.close();
    }
  });
  it("creates a local deployment artifact", async () => {
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-deploy-");

    const exitCode = await runCli(
      [
        "apply",
        path.join(repoRoot, "infra/examples/hello-webhook"),
        "--local-only",
        "--artifacts-dir",
        directory,
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText).toBe("");
    const [deploymentId] = await readdir(path.join(directory, "hello-webhook/1.0.0"));
    expect(io.stdoutText).toContain(`  id: ${deploymentId}\n  registered: false\n`);
  });

  it("creates a local artifact without asking an API for its environment", async () => {
    vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-deploy-offline-");

    const exitCode = await runCli(
      [
        "apply",
        path.join(repoRoot, "infra/examples/hello-webhook"),
        "--local-only",
        "--artifacts-dir",
        directory,
        // Nothing listens here, so any API call fails.
        "--api-url",
        "http://127.0.0.1:9",
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(await readdir(path.join(directory, "hello-webhook/1.0.0"))).toHaveLength(1);
  });
});
