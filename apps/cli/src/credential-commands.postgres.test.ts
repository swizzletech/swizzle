import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FULL_SCOPE } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";
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

useCliTestEnvironment();

describe("swizzle credential", () => {
  it("grants, revokes, shares and accepts a secret as each person may, in JSON", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("CRM_VALUE", "crm-token-value");
    const people = testPeople();
    const accessStore = testAccessStore();
    const apiTokenStore = testApiTokenStore();
    const office = await accessStore.createProject({ name: "Office", slug: "office" });
    const finance = await accessStore.createProject({ name: "Finance", slug: "finance" });
    /** A person with a role in one project, and a CLI profile acting as them. */
    const person = async (email: string, projectId: string, role: "admin" | "editor") => {
      const userId = await people.add(email);
      await accessStore.setGrant({ kind: "user", userId }, { on: "project", projectId, role });
      const { token } = await apiTokenStore.createToken({
        holder: { kind: "person", userId },
        issuedBy: { id: userId, name: email },
        name: "cli",
        scope: FULL_SCOPE,
      });
      return { email, token, userId };
    };
    const olga = await person("olga@office.test", office.id, "admin");
    // Offering a credential to a project needs sight of it: Olga views finance.
    await accessStore.setGrant(
      { kind: "user", userId: olga.userId },
      { on: "project", projectId: finance.id, role: "viewer" },
    );
    const anna = await person("anna@office.test", office.id, "editor");
    const carl = await person("carl@office.test", finance.id, "admin");
    const app = await buildTestServer({
      accessStore,
      apiTokenStore,
      auth: people.auth,
      platform: await testPlatform(),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.stubEnv("SWIZZLE_CONFIG_HOME", await temporaryDirectory("swizzle-cli-credential-"));
    const cli = async (...args: string[]) => {
      const io = createBufferIO();
      const exitCode = await runCli([...args, "--json"], io);
      return { exitCode, json: JSON.parse(io.stdoutText) };
    };
    for (const [name, who] of Object.entries({ anna, carl, olga })) {
      const added = await cli(
        ...["profile", "add", name, "--url", address, "--env", "staging", "--token", who.token],
      );
      expect(added.exitCode).toBe(0);
    }
    const onToken = ["secret", "CRM_TOKEN", "--project", "office"];

    try {
      const set = await cli(
        ...["secret", "set", "CRM_TOKEN", "--value-env", "CRM_VALUE", "--project", "office"],
        ...["--profile", "olga"],
      );
      expect(set.exitCode).toBe(0);

      const grant = ["credential", "grant", ...onToken, "--user", anna.email, "--right", "use"];
      const granted = await cli(...grant, "--profile", "olga");
      expect(granted).toEqual({
        exitCode: 0,
        json: {
          credential: "secret CRM_TOKEN",
          subject: `user ${anna.email}`,
          right: "use",
          state: "granted",
        },
      });
      expect((await cli(...grant, "--profile", "olga")).json.state).toBe("already granted (no-op)");

      const seen = await cli("credential", "access", ...onToken, "--profile", "anna");
      expect(seen.json).toMatchObject({
        credential: "secret CRM_TOKEN in staging",
        yourRight: "use",
        shares: "none",
      });
      expect(
        seen.json.holders.map(({ kind, right, from }: Record<string, string>) => [
          kind,
          right,
          from,
        ]),
      ).toEqual([
        ["user", "use", "use granted"],
        ["user", "manage", "admin of its project; manage granted"],
        // The owner the test harness signs the CLI in as.
        ["user", "manage", "instance owner"],
      ]);
      const selfPromoted = await cli(
        ...["credential", "grant", ...onToken, "--user", anna.email, "--right", "manage"],
        ...["--profile", "anna"],
      );
      expect(selfPromoted.exitCode).toBe(4);
      expect(selfPromoted.json.code).toBe("ACCESS_DENIED");
      // Repeating a held grant is no way around manage either.
      expect(await cli(...grant, "--profile", "anna")).toMatchObject({
        exitCode: 4,
        json: { code: "ACCESS_DENIED" },
      });

      const revoke = ["credential", "revoke", ...onToken, "--user", anna.email];
      expect((await cli(...revoke, "--profile", "olga")).json.state).toBe("revoked");
      expect((await cli(...revoke, "--profile", "olga")).json).toEqual({
        credential: "secret CRM_TOKEN",
        subject: `user ${anna.email}`,
        state: "not granted (no-op)",
      });
      expect((await cli("credential", "access", ...onToken, "--profile", "anna")).exitCode).toBe(4);

      const offered = await cli(
        ...["credential", "share", ...onToken, "--to", "finance", "--profile", "olga"],
      );
      expect(offered.json).toMatchObject({ to: "finance", state: "offered" });
      const listed = await cli("credential", "shares", "--project", "finance", "--profile", "carl");
      expect(listed.json.shares).toEqual([
        {
          id: offered.json.share,
          state: "offered",
          credential: "secret CRM_TOKEN",
          from: "Office in staging",
        },
      ]);
      const accepted = await cli(
        ...["credential", "accept", offered.json.share, "--project", "finance"],
        ...["--profile", "carl"],
      );
      expect(accepted.json).toMatchObject({
        share: offered.json.share,
        credential: "secret CRM_TOKEN in staging",
        state: "accepted",
      });
      const decline = ["credential", "decline", offered.json.share, "--project", "finance"];
      expect((await cli(...decline, "--profile", "carl")).json.state).toBe("declined");
      expect((await cli(...decline, "--profile", "carl")).json.state).toMatch(/\(no-op\)$/u);
      expect(
        (await cli("credential", "shares", "--project", "finance", "--profile", "carl")).json,
      ).toEqual({ shares: "0 credentials offered to finance" });
    } finally {
      await app.close();
    }
  });
  it("validates a secret its caller may not use with the refusal apply gives", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    vi.stubEnv("CRM_VALUE", "crm-token-value");
    const people = testPeople();
    const accessStore = testAccessStore();
    const apiTokenStore = testApiTokenStore();
    const office = await accessStore.createProject({ name: "Office", slug: "office" });
    const tokenOf = async (email: string, role: "admin" | "editor") => {
      const userId = await people.add(email);
      await accessStore.setGrant(
        { kind: "user", userId },
        { on: "project", projectId: office.id, role },
      );
      const created = await apiTokenStore.createToken({
        holder: { kind: "person", userId },
        issuedBy: { id: userId, name: email },
        name: "cli",
        scope: FULL_SCOPE,
      });
      return created.token;
    };
    const app = await buildTestServer({
      accessStore,
      apiTokenStore,
      auth: people.auth,
      // The stub's workers answer validate's readiness; nothing else here reads it.
      dashboard: createDashboardStub("unrelated"),
      platform: await testPlatform(),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.stubEnv("SWIZZLE_CONFIG_HOME", await temporaryDirectory("swizzle-cli-validate-"));
    const cli = async (...args: string[]) => {
      const io = createBufferIO();
      const exitCode = await runCli([...args, "--json"], io);
      return { exitCode, json: JSON.parse(io.stdoutText) };
    };
    for (const [name, role] of [
      ["olga", "admin"],
      ["anna", "editor"],
    ] as const) {
      const token = await tokenOf(`${name}@office.test`, role);
      await cli(
        ...["profile", "add", name, "--url", address, "--env", "staging", "--token", token],
        ...["--project", "office"],
      );
    }
    const automation = path.join(await temporaryDirectory("swizzle-cli-validate-"), "crm-sync");
    await mkdir(automation);
    await writeFile(
      path.join(automation, "config.yaml"),
      [
        "name: crm-sync",
        "version: 1.0.0",
        "entrypoint: main.js",
        "trigger: { type: webhook, path: /crm-sync }",
        "secrets: [CRM_TOKEN]",
        "api_check: { mode: passive }",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(automation, "main.js"), "console.log('{}');\n");
    // Both commands place the new automation in the profile's project.
    const asAnna = [automation, "--profile", "anna"];

    try {
      await cli(
        ...["secret", "set", "CRM_TOKEN", "--value-env", "CRM_VALUE", "--project", "office"],
        ...["--profile", "olga"],
      );
      const refused = {
        exitCode: 4,
        json: {
          code: "CREDENTIAL_USE_DENIED",
          details: { credentials: [{ kind: "secret", name: "CRM_TOKEN" }] },
        },
      };
      expect(await cli("apply", ...asAnna)).toMatchObject(refused);
      expect(await cli("validate", ...asAnna)).toMatchObject(refused);

      await cli(
        ...["credential", "grant", "secret", "CRM_TOKEN", "--project", "office"],
        ...["--user", "anna@office.test", "--right", "use", "--profile", "olga"],
      );
      expect(await cli("validate", ...asAnna)).toMatchObject({
        exitCode: 0,
        json: { valid: true },
      });
    } finally {
      await app.close();
    }
  });
});
