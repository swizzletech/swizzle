import path from "node:path";
import { FULL_SCOPE, type InstanceRole } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testAccessStore, testApiTokenStore } from "../../../test/stores.js";

import { temporaryDirectory } from "../../../test/support.js";
import {
  buildTestServer,
  createBufferIO,
  createDashboardStub,
  repoRoot,
  testPeople,
  useCliTestEnvironment,
} from "../test/cli-harness.js";
import { runCli } from "./main.js";

useCliTestEnvironment();

/**
 * An instance with an owner, Ada, and two members without grants, Anna and Ben, each with a CLI
 * profile named after them. `cli` runs a command as one of them and parses its JSON output.
 */
async function office() {
  vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
  const stateDirectory = await temporaryDirectory("swizzle-cli-access-");
  const people = testPeople();
  const apiTokenStore = testApiTokenStore();
  const accessStore = testAccessStore();
  const app = await buildTestServer({
    accessStore,
    apiTokenStore,
    auth: people.auth,
    // The read model lists what the caller's scope reaches; Ben's reaches nothing in production.
    dashboard: { ...createDashboardStub("hello-webhook"), listAutomations: async () => [] },
    environment: "staging",
    platform: await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    }),
  });
  const requests: string[] = [];
  app.addHook("onRequest", async (request) => {
    requests.push(`${request.method} ${request.url}`);
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  vi.stubEnv("SWIZZLE_CONFIG_HOME", path.join(stateDirectory, "config"));
  const cli = async (who: string, ...args: string[]) => {
    const start = requests.length;
    const io = createBufferIO();
    const exitCode = await runCli([...args, "--json", "--profile", who], io);
    return { exitCode, json: JSON.parse(io.stdoutText), requests: requests.slice(start) };
  };
  const people_: Record<string, InstanceRole> = { ada: "owner", anna: "member", ben: "member" };
  for (const [name, role] of Object.entries(people_)) {
    const userId = await people.add(`${name}@office.test`, { role });
    const { token } = await apiTokenStore.createToken({
      holder: { kind: "person", userId },
      issuedBy: { id: userId, name },
      name: "cli",
      scope: FULL_SCOPE,
    });
    const added = await runCli(
      ["profile", "add", name, "--url", address, "--env", "staging", "--token", token],
      createBufferIO(),
    );
    expect(added).toBe(0);
  }
  return { app, cli };
}

describe("swizzle access commands", () => {
  it("manages projects, teams, grants and service accounts with each person's dashboard rights", async () => {
    const { app, cli } = await office();

    try {
      const create = ["projects", "create", "office", "--name", "Office"];
      expect((await cli("ada", ...create)).json).toMatchObject({ state: "created" });
      expect((await cli("ada", ...create)).json.state).toBe("already exists (no-op)");
      expect((await cli("ben", "projects")).json).toMatchObject({
        projects: "0 projects you can see",
      });
      const rogue = await cli("ben", "projects", "create", "rogue", "--name", "Rogue");
      expect(rogue).toMatchObject({ exitCode: 4, json: { code: "ACCESS_DENIED" } });

      expect((await cli("ada", "teams", "create", "Developers")).json.state).toBe("created");
      const join = ["teams", "add", "Developers", "ben@office.test"];
      expect((await cli("ada", ...join)).json.state).toBe("added");
      expect((await cli("ada", ...join)).json.state).toBe("already a member (no-op)");
      expect((await cli("ada", "teams", "members", "Developers")).json.members).toEqual([
        { email: "ben@office.test", name: "ben" },
      ]);

      const admin = [
        "projects",
        "grant",
        "office",
        "--user",
        "anna@office.test",
        "--role",
        "admin",
      ];
      const granted = await cli("ada", ...admin);
      expect(granted.json.state).toBe("granted");
      expect(granted.requests).toEqual(["PUT /projects/office/grants"]);
      const unchanged = await cli("ada", ...admin);
      expect(unchanged.json.state).toBe("already held (no-op)");
      expect(unchanged.requests).toEqual(["PUT /projects/office/grants"]);

      // Anna administers office, so Anna manages its grants but not the instance's teams.
      const team = ["projects", "grant", "office", "--team", "Developers"];
      expect((await cli("anna", ...team, "--role", "editor")).json).toEqual({
        grant: { project: "office", subject: "Developers", on: "project", role: "editor" },
        state: "granted",
      });
      expect((await cli("anna", ...team, "--role", "editor")).json.state).toBe(
        "already held (no-op)",
      );
      expect((await cli("anna", ...team, "--role", "operator")).json.state).toBe(
        "changed from editor",
      );
      expect(await cli("anna", "teams", "create", "Contractors")).toMatchObject({
        exitCode: 4,
        json: {
          code: "ACCESS_DENIED",
          help: [
            "This needs the instance role admin; yours is member. An instance owner or admin does it, or changes your role in Settings > People.",
          ],
        },
      });
      expect((await cli("ben", "projects")).json.projects).toEqual([
        { slug: "office", name: "Office", role: "operator", protected: "production" },
      ]);
      const promoted = await cli(
        ...["ben", "projects", "grant", "office", "--user", "ben@office.test", "--role", "admin"],
      );
      expect(promoted).toMatchObject({ exitCode: 4, json: { code: "ACCESS_DENIED" } });

      const inOffice = ["--project", "office"];
      expect((await cli("anna", "service-accounts", ...inOffice)).json).toEqual({
        serviceAccounts: "0 service accounts in office",
        help: ["Run `swizzle service-accounts create <name> --project office` to create one"],
      });
      expect((await cli("anna", "service-accounts", "create", "ci", ...inOffice)).json.state).toBe(
        "created",
      );
      const ciGrant = [
        "--service-account",
        "ci",
        "--role",
        "editor",
        "--on-environment",
        "staging",
      ];
      // A grant on an environment needs the environment protected; the refusal names the fix.
      expect(await cli("anna", "projects", "grant", "office", ...ciGrant)).toMatchObject({
        exitCode: 8,
        json: {
          code: "ENVIRONMENT_NOT_PROTECTED",
          help: ["Run `swizzle projects protect office staging`", expect.any(String)],
        },
      });
      expect((await cli("anna", "projects", "protect", "office", "staging")).json.state).toBe(
        "protected",
      );
      expect((await cli("anna", "projects", "grant", "office", ...ciGrant)).json.state).toBe(
        "granted",
      );
      expect((await cli("anna", "service-accounts", ...inOffice)).json.serviceAccounts).toEqual([
        { name: "ci", grants: "staging=editor", liveTokens: 0, createdBy: "anna" },
      ]);
      const mint = await cli("anna", "service-accounts", "token", "create", "ci", ...inOffice);
      expect(mint).toMatchObject({ exitCode: 4, json: { code: "TOKEN_NEEDS_SIGN_IN" } });

      const access = (await cli("anna", "projects", "access", "office")).json;
      expect(access.holders).toContainEqual({
        name: "ben@office.test",
        kind: "user",
        role: "operator",
        environments: "staging=none production=none",
      });
      expect(access.grants).toContainEqual({
        subject: "ci",
        on: "environment staging",
        role: "editor",
      });

      const revoke = ["projects", "revoke", "office", "--team", "Developers"];
      expect((await cli("anna", ...revoke)).json.state).toBe("revoked");
      expect((await cli("anna", ...revoke)).json.state).toBe("not held (no-op)");
      expect((await cli("ben", "projects")).json.projects).toBe("0 projects you can see");

      const removeCi = ["service-accounts", "delete", "ci", ...inOffice];
      expect(await cli("anna", ...removeCi)).toMatchObject({
        exitCode: 2,
        json: { code: "CONFIRMATION_REQUIRED" },
      });
      expect((await cli("anna", ...removeCi, "--yes")).json.state).toBe("deleted");
      expect((await cli("anna", ...removeCi, "--yes")).json.state).toBe("already absent (no-op)");
    } finally {
      await app.close();
    }
  });

  it("shows the role a team's grant on a protected environment caps its members at", async () => {
    const { app, cli } = await office();
    try {
      await cli("ada", "projects", "create", "office", "--name", "Office");
      await cli("ada", "teams", "create", "Developers");
      await cli(
        ...["ada", "projects", "grant", "office", "--team", "Developers", "--role", "operator"],
        ...["--on-environment", "production"],
      );

      const access = (await cli("ada", "projects", "access", "office")).json;
      expect(access.holders).toContainEqual({
        name: "Developers",
        kind: "team",
        role: "none",
        environments: "staging=none production=operator (grant)",
      });
    } finally {
      await app.close();
    }
  });

  it("counts the environment grants unprotect removes and requires confirmation", async () => {
    const { app, cli } = await office();
    try {
      await cli("ada", "projects", "create", "office", "--name", "Office");
      await cli("ada", "projects", "protect", "office", "staging");
      await cli(
        "ada",
        "projects",
        "grant",
        "office",
        "--user",
        "anna@office.test",
        "--role",
        "editor",
        "--on-environment",
        "staging",
      );
      await cli(
        "ada",
        "projects",
        "grant",
        "office",
        "--user",
        "ben@office.test",
        "--role",
        "viewer",
        "--on-environment",
        "staging",
      );
      const command = ["projects", "unprotect", "office", "staging"];
      expect(await cli("ada", ...command)).toMatchObject({
        exitCode: 2,
        json: {
          code: "CONFIRMATION_REQUIRED",
          error: expect.stringContaining("2 grants"),
          help: ["Run `swizzle projects unprotect office staging --yes`"],
        },
      });
      const before = (await cli("ada", "projects", "access", "office")).json;
      expect(before.protected).toContain("staging");
      expect(
        before.grants.filter((grant: { on: string }) => grant.on === "environment staging"),
      ).toHaveLength(2);
      expect(await cli("ada", ...command, "--yes")).toMatchObject({
        exitCode: 0,
        json: { project: "office", environment: "staging", state: "unprotected", grantsRemoved: 2 },
      });
      const after = (await cli("ada", "projects", "access", "office")).json;
      expect(after.grants).toEqual([expect.objectContaining({ on: "environment production" })]);
      expect((await cli("ada", ...command)).json.state).toBe("already unprotected (no-op)");
    } finally {
      await app.close();
    }
  });

  it("answers ACCESS_DENIED, not a missing name, for an automation the caller may not reach", async () => {
    const { app, cli } = await office();
    const hello = path.join(repoRoot, "infra/examples/hello-webhook");

    try {
      await cli("ada", "projects", "create", "office", "--name", "Office");
      await cli(
        "ada",
        "projects",
        "grant",
        "office",
        "--user",
        "ben@office.test",
        "--role",
        "viewer",
      );
      expect(
        (await cli("ada", "apply", hello, "--project", "office", "-e", "production")).exitCode,
      ).toBe(0);
      // Production is protected from the start, so Ben's project grant does not reach it.
      expect((await cli("ada", "projects", "protect", "office", "production")).json.state).toBe(
        "already protected (no-op)",
      );

      // Ben's list for production is empty, so the name passes to the API, which says why.
      const denied = await cli("ben", "inspect", "hello-webhook", "-e", "production");
      expect(denied).toMatchObject({ exitCode: 4, json: { code: "ACCESS_DENIED" } });
      const missing = await cli("ben", "inspect", "no-such-automation", "-e", "production");
      expect(missing.exitCode).toBe(6);
    } finally {
      await app.close();
    }
  });

  it("previews a name taken in a project the caller cannot see as the refusal apply gives", async () => {
    const { app, cli } = await office();
    const hello = path.join(repoRoot, "infra/examples/hello-webhook");

    try {
      await cli("ada", "projects", "create", "office", "--name", "Office");
      await cli("ada", "projects", "create", "lab", "--name", "Lab");
      await cli("ada", "projects", "grant", "lab", "--user", "ben@office.test", "--role", "editor");
      await cli("ada", "apply", hello, "--project", "office", "-e", "staging");

      const apply = ["apply", hello, "--project", "lab", "-e", "staging"];
      const refused = await cli("ben", ...apply);
      expect(refused).toMatchObject({
        exitCode: 8,
        json: { code: "AUTOMATION_PROJECT_MISMATCH" },
      });
      const preview = await cli("ben", ...apply, "--dry-run");
      expect(preview).toMatchObject({ exitCode: refused.exitCode, json: refused.json });
    } finally {
      await app.close();
    }
  });

  it("deletes a non-empty project only once the caller says where its contents go", async () => {
    const { app, cli } = await office();
    const hello = path.join(repoRoot, "infra/examples/hello-webhook");

    try {
      for (const slug of ["office", "archive", "scratch"]) {
        await cli("ada", "projects", "create", slug, "--name", slug);
      }
      await cli("ada", "apply", hello, "--project", "archive", "-e", "staging");
      await cli("ada", "trigger", "pause", "hello-webhook", "-e", "staging");

      const archive = ["projects", "delete", "archive"];
      expect(await cli("ada", ...archive, "--move-to", "no-such-project", "--yes")).toMatchObject({
        exitCode: 6,
        json: { code: "PROJECT_MOVE_TARGET_NOT_FOUND" },
        requests: ["DELETE /projects/archive?confirm=true&contents=move&to=no-such-project"],
      });
      expect(await cli("ada", ...archive, "--yes")).toMatchObject({
        exitCode: 8,
        json: {
          code: "PROJECT_NOT_EMPTY",
          details: { automations: 1, credentials: 0, runs: 0 },
          help: [
            "Run `swizzle projects delete archive --move-to <project> --yes`",
            expect.stringContaining("swizzle projects delete archive --delete-contents --yes"),
          ],
        },
      });
      const both = await cli("ada", ...archive, "--move-to", "office", "--delete-contents");
      expect(both).toMatchObject({ exitCode: 2, json: { code: "OPTION_CONFLICT" } });
      expect(await cli("ada", ...archive, "--move-to", "office")).toMatchObject({
        exitCode: 2,
        json: {
          code: "CONFIRMATION_REQUIRED",
          help: ["Run `swizzle projects delete archive --move-to office --yes`"],
        },
      });
      expect((await cli("ada", ...archive, "--move-to", "office", "--yes")).json).toEqual({
        project: "archive",
        state: "deleted",
        contents: "1 automation moved to office",
      });
      expect((await cli("ada", "move", "hello-webhook", "--project", "office")).json.state).toBe(
        "already in project office (no-op)",
      );
      expect((await cli("ada", ...archive, "--yes")).json.state).toBe(
        "absent or not visible to you (no-op)",
      );

      const typescript = path.join(repoRoot, "infra/examples/typescript-webhook");
      await cli("ada", "apply", typescript, "--project", "scratch", "-e", "staging");
      await cli("ada", "trigger", "pause", "typescript-webhook", "-e", "staging");
      const scratch = ["projects", "delete", "scratch", "--delete-contents", "--yes"];
      expect((await cli("ada", ...scratch)).json.contents).toBe("1 automation deleted");
      expect((await cli("ada", "inspect", "typescript-webhook", "-e", "staging")).exitCode).toBe(6);

      await cli("ada", "projects", "create", "empty", "--name", "Empty");
      expect((await cli("ada", "projects", "delete", "empty", "--yes")).json).toEqual({
        project: "empty",
        state: "deleted",
        contents: "none",
      });
    } finally {
      await app.close();
    }
  });

  it("moves an automation once; moving it into the project it is in is a no-op", async () => {
    const { app, cli } = await office();
    const hello = path.join(repoRoot, "infra/examples/hello-webhook");

    try {
      await cli("ada", "projects", "create", "office", "--name", "Office");
      await cli("ada", "projects", "create", "archive", "--name", "Archive");
      await cli("ada", "apply", hello, "--project", "office", "-e", "staging");
      await cli("ada", "trigger", "pause", "hello-webhook", "-e", "staging");

      expect((await cli("ada", "move", "hello-webhook", "--project", "archive")).json).toEqual({
        automation: "hello-webhook",
        project: "archive",
        state: "moved",
        help: [
          "Run `swizzle trigger resume hello-webhook -e <environment>` in each environment to start it again",
        ],
      });
      expect((await cli("ada", "move", "hello-webhook", "--project", "archive")).json).toEqual({
        automation: "hello-webhook",
        state: "already in project archive (no-op)",
      });
    } finally {
      await app.close();
    }
  });

  it("invites a person without a mail server and prints the link that creates their account", async () => {
    vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", "http://dashboard.test");
    const { app, cli } = await office();

    try {
      await cli("ada", "projects", "create", "office", "--name", "Office");
      const invite = ["people", "invite", "carl@office.test", "--role", "member"];
      const sent = await cli("ada", ...invite, "--project", "office=editor");
      const refused = await cli("anna", ...invite);
      const token = String(sent.json.link).split("#")[1] ?? "";
      const joined = await app.inject({
        headers: { origin: "http://dashboard.test", "x-swizzle-invitation-token": token },
        method: "POST",
        payload: { email: "carl@office.test", name: "Carl", password: "carl's long passphrase" },
        url: "/auth/sign-up/email",
      });

      expect(sent).toMatchObject({
        exitCode: 0,
        json: {
          invitation: { email: "carl@office.test", projects: "office=editor", role: "member" },
          mailed: false,
        },
      });
      expect(sent.json.link).toMatch(/^http:\/\/dashboard\.test\/invitation#swzi_/u);
      expect(refused).toMatchObject({ exitCode: 4, json: { code: "ACCESS_DENIED" } });
      expect(joined.statusCode).toBe(200);
      expect((await cli("ada", "people")).json.people).toContainEqual({
        email: "carl@office.test",
        name: "Carl",
        role: "member",
      });
    } finally {
      await app.close();
    }
  });
});
