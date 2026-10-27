import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

import {
  buildTestServer,
  createBufferIO,
  createDashboardStub,
  fixturesRoot,
  useCliTestEnvironment,
} from "../test/cli-harness.js";

import { runCli } from "./main.js";

// Commands that talk to an API instance, run against a real in-process API server with PostgreSQL stores.
useCliTestEnvironment();

describe("trigger commands", () => {
  it("starts a cron automation by hand with its payload, as a manual run", async () => {
    const io = createBufferIO();
    const stateDirectory = await temporaryDirectory("swizzle-cli-trigger-cron-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(fixturesRoot, "cron-success"),
    });

    const app = await buildTestServer({
      dashboard: createDashboardStub("cron-success", "cron"),
      platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const exitCode = await runCli(
        [
          "trigger",
          "cron-success",
          "--payload",
          '{"dry_run":true}',
          "--json",
          "--api-url",
          address,
          "--exact",
        ],
        io,
      );

      expect(exitCode).toBe(0);
      const output = JSON.parse(io.stdoutText);
      expect(output.run).toMatchObject({ automation: "cron-success", status: "queued" });
      const run = await platform.getPlatformRun(output.run.id);
      expect(run.payload).toEqual({ dry_run: true });

      const processedRun = await platform.processNextPlatformRun();
      expect(processedRun?.triggerType).toBe("manual");
    } finally {
      await app.close();
    }
  });

  it("keeps empty manual cron trigger payload behavior when no payload is supplied", async () => {
    const io = createBufferIO();
    const stateDirectory = await temporaryDirectory("swizzle-cli-trigger-cron-empty-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(fixturesRoot, "cron-success"),
    });

    const app = await buildTestServer({
      dashboard: createDashboardStub("cron-success", "cron"),
      platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const exitCode = await runCli(
        ["trigger", "cron-success", "--json", "--api-url", address, "--exact"],
        io,
      );

      expect(exitCode).toBe(0);
      const run = await platform.getPlatformRun(JSON.parse(io.stdoutText).run.id);
      expect(run.payload).toEqual({});
    } finally {
      await app.close();
    }
  });

  it("starts a signed webhook automation by hand while its public path still refuses unsigned posts", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-cli-trigger-signed-");
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({
      dashboard: createDashboardStub("office-hook", "webhook"),
      platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const directory = path.join(stateDirectory, "office-hook");

    try {
      expect(await runCli(["init", directory, "--json"], createBufferIO())).toBe(0);
      vi.stubEnv("SIGNING_KEY", "a-random-signing-key");
      const secret = ["secret", "set", "OFFICE_HOOK_SIGNING_SECRET", "--value-env", "SIGNING_KEY"];
      expect(await runCli([...secret, "--api-url", address], createBufferIO())).toBe(0);
      const applied = createBufferIO();
      expect(await runCli(["apply", directory, "--json", "--api-url", address], applied)).toBe(0);
      const { webhookUrl } = JSON.parse(applied.stdoutText);

      const io = createBufferIO();
      const payload = '{"event":"contact.created"}';
      const args = ["trigger", "office-hook", "--payload", payload, "--json", "--api-url", address];
      const exitCode = await runCli([...args, "--exact"], io);
      const output = JSON.parse(io.stdoutText);
      expect(output).toMatchObject({ run: { automation: "office-hook", status: "queued" } });
      expect(exitCode).toBe(0);
      const { run } = output;
      expect((await platform.getPlatformRun(run.id)).payload).toEqual({ event: "contact.created" });

      const unsigned = await fetch(webhookUrl, { body: payload, method: "POST" });
      expect(unsigned.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid trigger payload JSON client-side", async () => {
    const io = createBufferIO();
    const app = await buildTestServer({
      dashboard: createDashboardStub("cron-success", "cron"),
      platform: await testPlatform(),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const exitCode = await runCli(
        ["trigger", "cron-success", "--payload", "{nope", "--json", "--api-url", address],
        io,
      );

      expect(exitCode).toBe(3);
      expect(JSON.parse(io.stdoutText)).toMatchObject({ code: "INVALID_PAYLOAD_JSON" });
    } finally {
      await app.close();
    }
  });
});
