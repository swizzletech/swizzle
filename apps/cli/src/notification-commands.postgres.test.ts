import path from "node:path";

import { FULL_SCOPE } from "@swizzle/db";

import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { testApiTokenStore } from "../../../test/stores.js";

import { temporaryDirectory } from "../../../test/support.js";

import {
  buildTestServer,
  createBufferIO,
  fixturesRoot,
  testPeople,
  useCliTestEnvironment,
} from "../test/cli-harness.js";

import { runCli } from "./main.js";

// Commands that talk to an API instance, run against a real in-process API server with PostgreSQL stores.
useCliTestEnvironment();

describe("notification commands", () => {
  it("manages a person's notification rules through the API", async () => {
    vi.stubEnv("SWIZZLE_CONFIG_HOME", await temporaryDirectory("swizzle-cli-notify-home-"));
    const io = createBufferIO();
    const artifactsDirectory = await temporaryDirectory("swizzle-cli-notify-");
    const platform = await testPlatform({ artifactsDirectory });
    const people = testPeople();
    const apiTokenStore = testApiTokenStore();
    const ada = await people.add("ada@example.com", { role: "owner" });
    const { token } = await apiTokenStore.createToken({
      holder: { kind: "person", userId: ada },
      issuedBy: { id: ada, name: "Ada" },
      name: "laptop",
      scope: FULL_SCOPE,
    });
    const app = await buildTestServer({ apiTokenStore, auth: people.auth, platform });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      await runCli(["profile", "add", "ada", "--url", address, "--token", token], createBufferIO());
      await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: path.join(fixturesRoot, "invalid-json-output"),
      });

      let exitCode = await runCli(
        [
          "notify",
          "create",
          "--automation",
          "invalid-json-output",
          "--event-type",
          "dead-lettered",
          "--chat-id",
          "-1001234567890",
          "--profile",
          "ada",
        ],
        io,
      );
      expect(exitCode).toBe(0);
      expect(io.stdoutText).toContain("state: created");

      const listIo = createBufferIO();
      exitCode = await runCli(["notify", "list", "--profile", "ada", "--json"], listIo);
      expect(exitCode).toBe(0);
      expect(JSON.parse(listIo.stdoutText)).toMatchObject({
        count: 1,
        rules: [{ chatId: "-1001234567890" }],
      });
    } finally {
      await app.close();
    }
  });
});
