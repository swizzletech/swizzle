import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testAccessStore, testApiTokenStore } from "../../../test/stores.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture, deployFixture } from "../test/automations.js";
import { testPeople } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

beforeEach(() => {
  vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("VALKEY_URL", "redis://127.0.0.1:1");
});

const VALUE = "crm-token-value";
// The run says whether it received the value, so the value itself never reaches its result.
const READS_TOKEN = `console.log(JSON.stringify({ has: process.env.CRM_TOKEN === "${VALUE}" }));`;
const TOKEN = "/credentials/secret/CRM_TOKEN";
const IN_OFFICE = "environment=staging&project=office";

/**
 * Project office holds the secret CRM_TOKEN in staging, set by its admin Olga. Anna and Ben edit
 * office; Carl administers finance, where Olga may look.
 */
async function office() {
  const platform = await testPlatform({
    artifactsDirectory: path.join(await temporaryDirectory("swizzle-credentials-"), "artifacts"),
  });
  const apiTokenStore = testApiTokenStore();
  const people = testPeople();
  const app = await buildTestServer({
    accessStore: testAccessStore(),
    apiTokenStore,
    auth: people.auth,
    platform,
  });
  const as =
    (who: { readonly authorization: string }) =>
    async (method: "DELETE" | "GET" | "POST" | "PUT", url: string, payload?: object) =>
      await app.inject({
        headers: { authorization: who.authorization },
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
  const owner = as(await people.bearer(apiTokenStore, "owner@office.test", "owner"));
  const person = async (email: string, grants: Record<string, string>) => {
    const bearer = await people.bearer(apiTokenStore, email);
    for (const [project, role] of Object.entries(grants)) {
      await owner("PUT", `/projects/${project}/grants`, { role, user: bearer.userId });
    }
    return { ...bearer, send: as(bearer) };
  };
  for (const slug of ["office", "finance"]) {
    expect((await owner("POST", "/projects", { name: slug, slug })).statusCode).toBe(201);
  }
  const olga = await person("olga@office.test", { finance: "viewer", office: "admin" });
  const anna = await person("anna@office.test", { office: "editor" });
  const ben = await person("ben@office.test", { office: "editor" });
  const carl = await person("carl@office.test", { finance: "admin" });
  const set = await olga.send("PUT", `/secrets/CRM_TOKEN?${IN_OFFICE}`, { value: VALUE });
  expect(set.statusCode).toBe(200);

  const deploy = async (
    who: { readonly authorization: string },
    input: { readonly mainJs?: string; readonly name: string; readonly project: string },
  ) =>
    await deployFixture(
      app,
      await createAutomationFixture({
        mainJs: input.mainJs ?? READS_TOKEN,
        name: input.name,
        path: `/${input.name}`,
        secrets: ["CRM_TOKEN"],
      }),
      { environment: "staging", project: input.project },
      { headers: { authorization: who.authorization } },
    );
  /** Triggers the automation as `who` and processes its run; the run, or the refusal. */
  const run = async (who: { readonly send: ReturnType<typeof as> }, automation: string) => {
    const queued = await who.send(
      "POST",
      `/automations/${automation}/runs?environment=staging`,
      {},
    );
    if (queued.statusCode !== 200) return queued.json();
    return await platform.processNextPlatformRun();
  };

  return { anna, app, ben, carl, deploy, olga, owner, platform, run };
}

describe("credential rights", { timeout: 60_000 }, () => {
  it("lets an editor with use deploy with a secret they cannot read, change or delete", async () => {
    const { anna, app, deploy, olga, run } = await office();
    expect(
      (await olga.send("PUT", `${TOKEN}/grants?${IN_OFFICE}`, { right: "use", user: anna.userId }))
        .statusCode,
    ).toBe(204);

    expect((await deploy(anna, { name: "crm-sync", project: "office" })).statusCode).toBe(200);
    expect(await run(anna, "crm-sync")).toMatchObject({ result: { has: true } });

    const attempts = [
      await anna.send("PUT", `/secrets/CRM_TOKEN?${IN_OFFICE}`, { value: "replaced" }),
      await anna.send("DELETE", `/secrets/CRM_TOKEN?${IN_OFFICE}`),
      await anna.send("PUT", `${TOKEN}/grants?${IN_OFFICE}`, {
        right: "manage",
        user: anna.userId,
      }),
      await anna.send("DELETE", `${TOKEN}/grants?${IN_OFFICE}&user=${anna.userId}`),
      await anna.send("PUT", `${TOKEN}/shares/finance?${IN_OFFICE}`),
    ];
    expect(attempts.map((response) => [response.statusCode, response.json().code])).toEqual(
      Array(5).fill([403, "ACCESS_DENIED"]),
    );
    // She reads who holds it, as someone who may change nothing.
    const access = await anna.send("GET", `${TOKEN}/access?${IN_OFFICE}`);
    expect(access.json()).toMatchObject({ grants: expect.any(Array), right: "use" });
    attempts.push(access);
    const listed = await anna.send("GET", "/secrets?environment=staging");
    expect(listed.json().secrets).toEqual([
      expect.objectContaining({ name: "CRM_TOKEN", right: "use" }),
    ]);
    for (const response of [...attempts, listed]) expect(response.body).not.toContain(VALUE);
    expect(await run(anna, "crm-sync")).toMatchObject({ result: { has: true } });
    await app.close();
  });

  it("lists each holder of a credential with every source of their right", async () => {
    const { anna, app, ben, olga, owner } = await office();
    const team = (await owner("POST", "/teams", { name: "Billing" })).json();
    await owner("PUT", `/teams/${team.id}/members/${ben.userId}`);
    await owner("PUT", `/teams/${team.id}/members/${anna.userId}`);
    await olga.send("PUT", `${TOKEN}/grants?${IN_OFFICE}`, { right: "use", team: "Billing" });
    await olga.send("PUT", `${TOKEN}/grants?${IN_OFFICE}`, { right: "manage", user: anna.userId });

    const { holders, right } = (await ben.send("GET", `${TOKEN}/access?${IN_OFFICE}`)).json();
    expect(right).toBe("use");
    const byName = Object.fromEntries(
      holders.map((holder: { name: string; right: string; sources: unknown[] }) => [
        holder.name,
        [holder.right, holder.sources],
      ]),
    );
    expect(byName).toEqual({
      // Anna edits office, so her manage grant manages; the team grant reaches her too.
      anna: [
        "manage",
        [
          { kind: "team", right: "use", teamId: team.id, teamName: "Billing" },
          { kind: "grant", right: "manage" },
        ],
      ],
      ben: ["use", [{ kind: "team", right: "use", teamId: team.id, teamName: "Billing" }]],
      Billing: ["use", [{ kind: "grant", right: "use" }]],
      // Olga created it and administers office; the owner holds it by instance role.
      olga: [
        "manage",
        [
          { kind: "role", role: "project-admin" },
          { kind: "grant", right: "manage" },
        ],
      ],
      owner: ["manage", [{ kind: "role", role: "owner" }]],
    });
    await app.close();
  });

  it("refuses a changed version that declares a secret its deployer may not use", async () => {
    const { anna, app, ben, deploy, olga, run } = await office();
    await olga.send("PUT", `${TOKEN}/grants?${IN_OFFICE}`, { right: "use", user: anna.userId });
    expect((await deploy(anna, { name: "crm-sync", project: "office" })).statusCode).toBe(200);

    const changed = await deploy(ben, {
      mainJs: `console.log(JSON.stringify({ leaked: process.env.CRM_TOKEN }));`,
      name: "crm-sync",
      project: "office",
    });
    expect(changed.statusCode).toBe(403);
    expect(changed.json()).toMatchObject({
      code: "CREDENTIAL_USE_DENIED",
      details: { credentials: [{ kind: "secret", name: "CRM_TOKEN" }] },
    });
    // Ben still operates what Anna published: its unchanged version and its runs.
    expect((await deploy(ben, { name: "crm-sync", project: "office" })).json()).toMatchObject({
      action: "noop",
    });
    expect(await run(ben, "crm-sync")).toMatchObject({ result: { has: true } });
    // Nor does replacing the value or creating it anew get round the right.
    const replaced = await ben.send("PUT", `/secrets/CRM_TOKEN?${IN_OFFICE}`, { value: "mine" });
    expect(replaced.statusCode).toBe(403);
    await app.close();
  });

  it("blocks the next deploy once use is revoked, and the next injection once a share is", async () => {
    const { anna, app, carl, deploy, olga, platform, run } = await office();
    await olga.send("PUT", `${TOKEN}/grants?${IN_OFFICE}`, { right: "use", user: anna.userId });
    expect((await deploy(anna, { name: "crm-sync", project: "office" })).statusCode).toBe(200);
    const revoked = await olga.send("DELETE", `${TOKEN}/grants?${IN_OFFICE}&user=${anna.userId}`);
    expect(revoked.statusCode).toBe(204);
    const next = await deploy(anna, {
      mainJs: `${READS_TOKEN}\n// v2`,
      name: "crm-sync",
      project: "office",
    });
    expect(next.json()).toMatchObject({ code: "CREDENTIAL_USE_DENIED" });

    // Olga offers the secret to finance; it binds there once Carl accepts.
    const offered = await olga.send("PUT", `${TOKEN}/shares/finance?${IN_OFFICE}`);
    expect(offered.json()).toMatchObject({
      acceptedAt: null,
      project: expect.objectContaining({ id: expect.any(String) }),
    });
    // Office lists what it shares to those who manage it; Anna, who no longer holds a right, sees none.
    const sharedBy = (who: typeof olga) =>
      who.send("GET", "/projects/office/shared-credentials?environment=staging");
    expect((await sharedBy(olga)).json().credentials).toEqual([
      {
        credential: expect.objectContaining({ kind: "secret", name: "CRM_TOKEN" }),
        shares: [
          expect.objectContaining({
            acceptedAt: null,
            project: expect.objectContaining({ name: "finance", slug: "finance" }),
          }),
        ],
      },
    ]);
    expect((await sharedBy(anna)).json().credentials).toEqual([]);
    const early = await deploy(carl, { name: "ledger", project: "finance" });
    expect(early.json()).toMatchObject({ code: "PLATFORM_REQUIRED_SECRETS_MISSING" });
    const { shares } = (await carl.send("GET", "/projects/finance/credential-shares")).json();
    expect(shares).toEqual([
      expect.objectContaining({
        credential: expect.objectContaining({ name: "CRM_TOKEN" }),
        credentialProject: expect.objectContaining({ name: "office", slug: "office" }),
        project: expect.objectContaining({ name: "finance", slug: "finance" }),
      }),
    ]);
    const accepted = await carl.send(
      "PUT",
      `/projects/finance/credential-shares/${shares[0].shareId}`,
    );
    expect(accepted.json()).toMatchObject({ acceptedAt: expect.any(String) });
    expect((await deploy(carl, { name: "ledger", project: "finance" })).statusCode).toBe(200);
    expect(await run(carl, "ledger")).toMatchObject({ result: { has: true } });

    // A run queued before the revocation does not receive the value either.
    const queued = await carl.send("POST", "/automations/ledger/runs?environment=staging", {});
    expect(queued.statusCode).toBe(200);
    expect((await olga.send("DELETE", `${TOKEN}/shares/finance?${IN_OFFICE}`)).statusCode).toBe(
      204,
    );
    expect(await platform.processNextPlatformRun()).toMatchObject({
      errorCode: "PLATFORM_REQUIRED_SECRETS_MISSING",
    });
    expect(await run(carl, "ledger")).toMatchObject({ code: "PLATFORM_REQUIRED_SECRETS_MISSING" });
    const redeploy = await deploy(carl, {
      mainJs: `${READS_TOKEN}\n// v2`,
      name: "ledger",
      project: "finance",
    });
    expect(redeploy.json()).toMatchObject({ code: "PLATFORM_REQUIRED_SECRETS_MISSING" });
    await app.close();
  });
});
