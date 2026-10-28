import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FULL_SCOPE } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";
import { version as releaseVersion } from "../../../package.json";

import { testPlatform } from "../../../test/platform.js";

import { testAccessStore, testApiTokenStore } from "../../../test/stores.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

import {
  buildTestServer,
  createBufferIO,
  createDashboardStub,
  testPeople,
  useCliTestEnvironment,
} from "../test/cli-harness.js";

import { runCli } from "./main.js";

// Commands that talk to an API instance, run against a real in-process API server with PostgreSQL stores.
useCliTestEnvironment();

describe("status commands", () => {
  it("doctor reports per-check preflight status and fails when one check fails", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-cli-doctor-");
    const artifactsDirectory = path.join(stateDirectory, "artifacts");

    const platform = await testPlatform({ artifactsDirectory });
    const app = await buildTestServer({
      platform,
      dashboard: createDashboardStub("hello-webhook"),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const io = createBufferIO();
      expect(await runCli(["doctor", "--json", "--api-url", address], io)).toBe(0);
      expect(JSON.parse(io.stdoutText)).toMatchObject({
        result: "all checks passed",
        checks: ["api", "ready", "auth", "secrets", "connections"].map((name) => ({
          name,
          status: "pass",
        })),
        serverVersion: releaseVersion,
      });

      // A regular file where the artifacts directory belongs fails the probe, root included.
      await rm(artifactsDirectory, { recursive: true });
      await writeFile(artifactsDirectory, "");
      const failingIo = createBufferIO();
      expect(await runCli(["doctor", "--json", "--api-url", address], failingIo)).toBe(1);
      expect(JSON.parse(failingIo.stdoutText)).toMatchObject({
        result: expect.stringMatching(/^1 of \d+ checks failed$/u),
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "ready", status: "fail" }),
        ]),
      });
    } finally {
      await app.close();
    }
  });

  it.each([503, 401, 403, 200])(
    "doctor reports environment discovery failure with HTTP %s while continuing its other checks",
    async (status) => {
      vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
      const app = await buildTestServer({
        platform: await testPlatform(),
        dashboard: createDashboardStub("hello-webhook"),
      });
      app.addHook("onRequest", async (request, reply) => {
        if (request.url === "/environments") {
          return reply
            .code(status)
            .send(
              status === 200
                ? { malformed: true }
                : { error: "ENVIRONMENT_LOOKUP_FAILED", message: "Environment store unavailable." },
            );
        }
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      try {
        const io = createBufferIO();
        expect(await runCli(["doctor", "--json", "--api-url", address], io)).toBe(1);
        expect(JSON.parse(io.stdoutText)).toMatchObject({
          environment: null,
          checks: expect.arrayContaining([
            {
              name: "environment",
              status: "fail",
              detail:
                status === 200
                  ? `API_RESPONSE_INVALID: The API at ${address}/environments returned invalid environment information.`
                  : "ENVIRONMENT_LOOKUP_FAILED: Environment store unavailable.",
            },
            { name: "api", status: "pass", detail: "API reachable" },
          ]),
        });
      } finally {
        await app.close();
      }
    },
  );

  it("doctor reports an unreachable API even when it cannot learn the environment", async () => {
    vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
    const io = createBufferIO();
    // Nothing listens here, so the instance cannot name its environment either.
    expect(await runCli(["doctor", "--json", "--api-url", "http://127.0.0.1:9"], io)).toBe(1);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      checks: expect.arrayContaining([expect.objectContaining({ name: "api", status: "fail" })]),
      environment: null,
    });
  });

  it("whoami shows the identity, project, environment and role each profile acts as", async () => {
    vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
    const people = testPeople();
    const accessStore = testAccessStore();
    const apiTokenStore = testApiTokenStore();
    const ada = await people.add("ada@example.com", { role: "owner" });
    const office = await accessStore.createProject({ name: "Office", slug: "office" });
    const deployer = await accessStore.createServiceAccount({
      createdBy: { id: ada, name: "Ada" },
      name: "deployer",
      projectId: office.id,
    });
    const subject = { kind: "service-account", serviceAccountId: deployer.id } as const;
    await accessStore.setGrant(subject, { on: "project", projectId: office.id, role: "editor" });
    const bot = await apiTokenStore.createToken({
      holder: subject,
      issuedBy: { id: ada, name: "Ada" },
      name: "ci",
      scope: { environments: ["staging"], projectIds: null, role: "editor" },
    });
    const laptop = await apiTokenStore.createToken({
      holder: { kind: "person", userId: ada },
      issuedBy: { id: ada, name: "Ada" },
      name: "laptop",
      scope: { environments: null, projectIds: [office.id], role: "operator" },
    });
    const desk = await apiTokenStore.createToken({
      holder: { kind: "person", userId: ada },
      issuedBy: { id: ada, name: "Ada" },
      name: "desk",
      scope: FULL_SCOPE,
    });
    const app = await buildTestServer({
      accessStore,
      apiTokenStore,
      auth: people.auth,
      platform: await testPlatform(),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.stubEnv("SWIZZLE_CONFIG_HOME", await temporaryDirectory("swizzle-cli-whoami-"));
    const cli = async (...args: string[]) => {
      const io = createBufferIO();
      return { exitCode: await runCli(args, io), io };
    };

    try {
      const added = await cli(
        ...["profile", "add", "bot", "--url", address, "--env", "staging", "--project", "office"],
        ...["--token", bot.token],
      );
      await cli(
        "profile",
        "add",
        "ada",
        "--url",
        address,
        "--env",
        "staging",
        "--token",
        laptop.token,
      );
      await cli(
        "profile",
        "add",
        "desk",
        "--url",
        address,
        "--env",
        "staging",
        "--token",
        desk.token,
      );
      const asBot = await cli("whoami", "--profile", "bot");
      const atDesk = await cli("whoami", "--profile", "desk", "--json");
      const asAda = await cli("whoami", "--profile", "ada", "--project", "office", "--json");
      const botInProduction = await cli("whoami", "--profile", "bot", "-e", "production", "--json");

      expect(added.exitCode).toBe(0);
      expect(asBot.io.stdoutText).toBe(
        [
          `profile: "bot (flag) ${address}"`,
          "identity: service account deployer of project office",
          `token: "ci; at most editor; projects all; environments staging; expires ${bot.expiresAt}"`,
          "project: office (from profile)",
          "environment: staging (from profile)",
          "role: editor",
          "",
        ].join("\n"),
      );
      expect(JSON.parse(asAda.io.stdoutText)).toMatchObject({
        identity: "person ada <ada@example.com>, instance role owner",
        token: expect.stringMatching(
          /^laptop; at most operator; projects office; environments all;/u,
        ),
        project: "office (from flag)",
        environment: "staging (from profile)",
        role: "operator",
      });
      // A person's token without limits acts with all their rights, an owner's beyond project admin.
      expect(JSON.parse(atDesk.io.stdoutText).token).toBe(
        `desk; all your rights; expires ${desk.expiresAt}`,
      );
      expect(JSON.parse(botInProduction.io.stdoutText)).toMatchObject({
        environment: "production (from flag)",
        role: "none: project office is out of reach",
      });
      expect(asBot.io.stdoutText + asAda.io.stdoutText).not.toContain(bot.token);
    } finally {
      await app.close();
    }
  });

  it("security audit reports the authenticated instance posture", async () => {
    vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
    vi.stubEnv("API_HOST", "127.0.0.1");
    vi.stubEnv("SWIZZLE_CONTROL_EGRESS_PROXY", "http://runner-egress-proxy:3128");
    vi.stubEnv("SWIZZLE_REQUIRE_SANDBOX", "true");
    vi.stubEnv("SWIZZLE_RUNNER_EGRESS_PROXY", "http://runner-egress-proxy:3128");
    const people = testPeople();
    const auth = people.auth;
    const apiTokenStore = testApiTokenStore();
    const ada = await people.add("ada@example.com", { role: "owner" });
    const apiToken = await apiTokenStore.createToken({
      holder: { kind: "person", userId: ada },
      issuedBy: { id: ada, name: "Ada" },
      name: "audit-test",
      scope: FULL_SCOPE,
    });
    const app = await buildTestServer({
      apiTokenStore,
      auth,
      dashboard: createDashboardStub("hello-webhook"),
      platform: await testPlatform(),
    });
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", undefined);
    const requests: string[] = [];
    app.addHook("onRequest", async (request) => {
      requests.push(request.url);
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const configHome = await temporaryDirectory("swizzle-cli-audit-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);
    await writeFile(
      path.join(configHome, "config.toml"),
      `[profile.audit]\nurl = "${address}"\ntoken = "${apiToken.token}"\n`,
      "utf8",
    );

    try {
      const attentionIo = createBufferIO();
      const attentionExit = await runCli(
        ["security", "audit", "--json", "--profile", "audit"],
        attentionIo,
      );
      expect(attentionExit).toBe(1);
      expect(JSON.parse(attentionIo.stdoutText)).toMatchObject({
        status: "attention",
        checks: expect.arrayContaining([
          expect.objectContaining({ id: "encryption-key", level: "critical" }),
        ]),
      });

      vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
      const io = createBufferIO();
      const exitCode = await runCli(
        ["-e", "production", "security", "audit", "--json", "--profile", "audit"],
        io,
      );

      expect(exitCode).toBe(0);
      expect(requests).toEqual(["/security/audit", "/security/audit"]);
      const report = JSON.parse(io.stdoutText);
      expect(report.status).toBe("ok");
      // Warnings leave the status ok; the default view lists only what needs attention.
      expect(report.checks.map((check: { level: string }) => check.level)).not.toContain("pass");
      expect(report.checks.map((check: { level: string }) => check.level)).not.toContain(
        "critical",
      );
    } finally {
      await app.close();
    }
  });
});
