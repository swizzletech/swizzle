import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";

import { buildTestServer, createBufferIO, useCliTestEnvironment } from "../test/cli-harness.js";

import { runCli } from "./main.js";

// Commands that talk to an API instance, run against a real in-process API server with PostgreSQL stores.
useCliTestEnvironment();

describe("credential commands", () => {
  it("manages platform secrets through the API without echoing secret values", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("SWIZZLE_TEST_SECRET_VALUE", "env-secret-token");
    const app = await buildTestServer({ platform: await testPlatform() });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const values = ["very-secret-token", "env-secret-token", "different-value", "rotated-value"];
    const cli = async (...args: string[]) => {
      const io = createBufferIO();
      const exitCode = await runCli([...args, "--json", "--api-url", address], io);
      for (const value of values) expect(io.stdoutText + io.stderrText).not.toContain(value);
      return { exitCode, json: JSON.parse(io.stdoutText) };
    };

    try {
      expect(await cli("secret", "set", "API_TOKEN", "--value", "very-secret-token")).toEqual({
        exitCode: 0,
        json: { secret: { name: "API_TOKEN", environment: "local", version: 1, state: "created" } },
      });
      const fromEnv = await cli(
        ...["secret", "set", "ENV_API_TOKEN", "--value-env", "SWIZZLE_TEST_SECRET_VALUE"],
      );
      expect(fromEnv.json.secret.state).toBe("created");

      for (const source of [[], ["--value", "x", "--value-env", "SWIZZLE_TEST_SECRET_VALUE"]]) {
        const refused = await cli("secret", "set", "MISSING_VALUE", ...source);
        expect(refused.exitCode).toBe(2);
        expect(refused.json.code).toBe("SECRET_VALUE_SOURCE_REQUIRED");
      }

      expect((await cli("secret", "inspect", "API_TOKEN")).json.secret).toMatchObject({
        name: "API_TOKEN",
        project: "default",
        version: 1,
      });
      expect((await cli("secret", "list")).json).toMatchObject({
        count: 2,
        secrets: [
          { name: "API_TOKEN", project: "default" },
          { name: "ENV_API_TOKEN", project: "default" },
        ],
      });

      // The API refuses the second create under its lock, so two racing sets cannot both win.
      const taken = await cli("secret", "set", "API_TOKEN", "--value", "different-value");
      expect(taken.exitCode).toBe(8);
      expect(taken.json.code).toBe("SECRET_ALREADY_EXISTS");

      const replaced = await cli(
        ...["secret", "set", "API_TOKEN", "--value", "rotated-value", "--overwrite"],
      );
      expect(replaced.json.secret).toMatchObject({
        version: 2,
        state: "replaced; the previous value is not recoverable",
      });

      const remove = ["secret", "delete", "API_TOKEN", "--yes"];
      expect((await cli(...remove)).json).toEqual({
        secret: "API_TOKEN",
        environment: "local",
        state: "deleted",
      });
      expect((await cli(...remove)).json.state).toBe("already absent (no-op)");
    } finally {
      await app.close();
    }
  });

  it("tells same-named connections of two projects apart and points each follow-up at its own", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("SWIZZLE_GOOGLE_SECRET", "client-secret");
    const app = await buildTestServer({ platform: await testPlatform() });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const cli = async (...args: string[]) => {
      const io = createBufferIO();
      const exitCode = await runCli([...args, "--json", "--api-url", address], io);
      return { exitCode, json: JSON.parse(io.stdoutText) };
    };
    const google = ["--provider", "google", "--client-id", "id", "--scopes", "openid"];
    const secret = ["--client-secret-env", "SWIZZLE_GOOGLE_SECRET"];

    try {
      expect((await cli("projects", "create", "billing", "--name", "Billing")).exitCode).toBe(0);
      const billing = await cli(
        ...["connections", "authorize", "google", ...google, ...secret],
        ...["--project", "billing"],
      );
      expect(billing.json.connection.project).toBe("billing");
      expect(billing.json.help).toContain(
        `Run \`swizzle connections inspect google --project billing -e local\` to see when it is active`,
      );
      await cli("connections", "authorize", "google", ...google, ...secret);

      expect(
        (await cli("connections", "inspect", "google", "--project", "billing")).json.connection
          .project,
      ).toBe("billing");
      const rows = (await cli("connections", "list")).json.connections;
      expect(rows.map((row: { project: string }) => row.project).sort()).toEqual([
        "billing",
        "default",
      ]);
    } finally {
      await app.close();
    }
  });
});
