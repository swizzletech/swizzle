import type { MailMessage } from "@swizzle/core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";
import { DASHBOARD_ORIGIN, testBrowser } from "../test/browser.js";
import { buildTestServer } from "../test/server-harness.js";

const ADA = { email: "ada@example.com", name: "Ada", password: "correct horse battery staple" };
const PAULA = { email: "paula@example.com", name: "Paula", password: "paula's long passphrase" };
const MIA = { email: "mia@example.com", name: "Mia", password: "mia's long passphrase" };

beforeEach(() => {
  vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", DASHBOARD_ORIGIN);
  vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
});

/**
 * An office instance: owner Ada signed in, projects office and finance, and a member who joined
 * through an invitation for each person the test names.
 */
async function office(...members: (typeof PAULA)[]) {
  const mails: MailMessage[] = [];
  const app = await buildTestServer({
    links: {
      origin: DASHBOARD_ORIGIN,
      mailer: { send: async (mail) => void mails.push(mail) },
    },
  });
  onTestFinished(() => app.close());
  const ada = testBrowser(app);
  expect((await ada.send("POST", "/auth/sign-up/email", ADA)).statusCode).toBe(200);
  for (const [slug, name] of [
    ["office", "Office"],
    ["finance", "Finance"],
  ] as const) {
    expect((await ada.send("POST", "/projects", { name, slug })).statusCode).toBe(201);
  }
  const joined = [];
  for (const person of members) {
    await ada.send("POST", "/invitations", { email: person.email, role: "member" });
    const token = new RegExp(`${DASHBOARD_ORIGIN}/invitation#(\\S+)`, "u").exec(
      mails.at(-1)?.text ?? "",
    )?.[1];
    const browser = testBrowser(app, "198.51.100.20");
    const signedUp = await browser.send("POST", "/auth/sign-up/email", person, {
      "x-swizzle-invitation-token": token ?? "",
    });
    expect(signedUp.statusCode).toBe(200);
    const id: string = (await browser.send("GET", "/auth/status")).json().user.id;
    joined.push({ browser, id });
  }
  const bearer = (token: string) => ({
    send: (method: "DELETE" | "GET" | "POST" | "PUT", url: string, payload?: object) =>
      app.inject({
        headers: { authorization: `Bearer ${token}` },
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      }),
  });
  return { ada, app, bearer, joined };
}

// Sign-ins hash with production-cost scrypt; see sign-in.test.ts.
describe("tokens and service accounts over HTTP", () => {
  it("takes a team's rights from an agent token on the next request after its person leaves", async () => {
    const { ada, bearer, joined } = await office(MIA);
    const [mia] = joined;
    if (mia === undefined) throw new Error("Mia did not join.");
    const team = (await ada.send("POST", "/teams", { name: "Bookkeeping" })).json();
    await ada.send("PUT", `/teams/${team.id}/members/${mia.id}`);
    await ada.send("PUT", "/projects/office/grants", { role: "editor", team: team.id });
    const minted = await mia.browser.send("POST", "/auth/tokens", { name: "laptop" });
    const asMia = bearer(minted.json().token);
    const identity = () => asMia.send("GET", "/auth/identity?project=office&environment=staging");

    const before = (await identity()).json();
    const writeBefore = await asMia.send(
      "PUT",
      "/secrets/SMTP?project=office&environment=staging",
      {
        value: "v1",
      },
    );
    await ada.send("DELETE", `/teams/${team.id}/members/${mia.id}`);
    const after = (await identity()).json();
    const writeAfter = await asMia.send("PUT", "/secrets/SMTP?project=office&environment=staging", {
      value: "v2",
    });

    expect(before).toMatchObject({
      kind: "person",
      person: { email: MIA.email, role: "member" },
      target: { environment: "staging", project: { slug: "office" }, role: "editor" },
      token: { name: "laptop", scope: { environments: null, projects: null, role: "admin" } },
    });
    expect(writeBefore.statusCode).toBe(200);
    expect(after.target).toEqual({
      environment: "staging",
      project: { reference: "office" },
      role: null,
    });
    expect(writeAfter.statusCode).toBe(404);
    expect((await asMia.send("GET", "/projects")).json().projects).toEqual([]);
  });

  it("keeps a service account's token working within its scope after its creator is suspended", async () => {
    const { ada, bearer, joined } = await office(PAULA);
    const [paula] = joined;
    if (paula === undefined) throw new Error("Paula did not join.");
    await ada.send("PUT", "/projects/office/grants", { role: "admin", user: PAULA.email });
    const created = await paula.browser.send("POST", "/projects/office/service-accounts", {
      name: "deployer",
    });
    const asAdmin = await paula.browser.send("PUT", "/projects/office/grants", {
      role: "admin",
      serviceAccount: "deployer",
    });
    await paula.browser.send("PUT", "/projects/office/grants", {
      role: "editor",
      serviceAccount: "deployer",
    });
    // Production is protected: this grant lets the account's rights reach it, the token does not.
    await paula.browser.send("PUT", "/projects/office/grants", {
      environment: "production",
      role: "editor",
      serviceAccount: "deployer",
    });
    const minted = await paula.browser.send(
      "POST",
      "/projects/office/service-accounts/deployer/tokens",
      { name: "ci", scope: { environments: ["staging"] } },
    );
    const asDeployer = bearer(minted.json().token);

    await ada.send("PUT", `/users/${paula.id}/suspension`);
    const identity = await asDeployer.send(
      "GET",
      "/auth/identity?project=office&environment=staging",
    );
    const staging = await asDeployer.send(
      "PUT",
      "/secrets/SMTP?project=office&environment=staging",
      { value: "v1" },
    );
    const production = await asDeployer.send(
      "PUT",
      "/secrets/SMTP?project=office&environment=production",
      { value: "v1" },
    );
    const finance = await asDeployer.send(
      "PUT",
      "/secrets/SMTP?project=finance&environment=staging",
      { value: "v1" },
    );
    const grant = await asDeployer.send("PUT", "/projects/office/grants", {
      role: "viewer",
      user: ADA.email,
    });
    const listed = (await ada.send("GET", "/projects/office/service-accounts")).json();

    expect(created.statusCode).toBe(201);
    expect(asAdmin.statusCode).toBe(400);
    expect(minted.statusCode).toBe(201);
    expect(identity.json()).toMatchObject({
      kind: "service-account",
      person: null,
      serviceAccount: { name: "deployer", project: { slug: "office" } },
      target: { role: "editor" },
      token: {
        issuedBy: { name: PAULA.name },
        scope: { environments: ["staging"], role: "editor" },
      },
    });
    expect(staging.statusCode).toBe(200);
    expect(production.json()).toMatchObject({
      code: "ACCESS_DENIED",
      details: { role: null, scope: { environments: ["staging"] } },
    });
    expect(finance.statusCode).toBe(404);
    expect(grant.statusCode).toBe(403);
    expect(listed.serviceAccounts).toEqual([
      expect.objectContaining({
        createdBy: { id: paula.id, name: PAULA.name },
        name: "deployer",
        tokens: [expect.objectContaining({ lastUsedAt: expect.any(String), name: "ci" })],
      }),
    ]);

    // Once Paula is removed the card still says who set the account up and minted its token.
    expect((await ada.send("DELETE", `/users/${paula.id}`)).statusCode).toBe(204);
    const kept = (await ada.send("GET", "/projects/office/service-accounts")).json();
    expect(kept.serviceAccounts).toEqual([
      expect.objectContaining({
        createdBy: { id: paula.id, name: PAULA.name },
        tokens: [expect.objectContaining({ issuedBy: { id: paula.id, name: PAULA.name } })],
      }),
    ]);
  });

  it("names both the token's scope and the protection that refuse a service account", async () => {
    const { ada, bearer } = await office();
    await ada.send("POST", "/projects/office/service-accounts", { name: "deployer" });
    await ada.send("PUT", "/projects/office/grants", {
      role: "editor",
      serviceAccount: "deployer",
    });
    const minted = await ada.send("POST", "/projects/office/service-accounts/deployer/tokens", {
      name: "ci",
      scope: { environments: ["staging"] },
    });
    const asDeployer = bearer(minted.json().token);

    const production = await asDeployer.send(
      "GET",
      "/secrets?project=office&environment=production",
    );

    expect(production.statusCode).toBe(403);
    expect(production.json()).toMatchObject({
      code: "ACCESS_DENIED",
      details: {
        protectedEnvironment: "production",
        role: null,
        scope: { environments: ["staging"] },
      },
      message: expect.stringContaining("with this token, which reaches only staging."),
    });
  });

  it("lets a token limited to staging edit there but never administer its project", async () => {
    const { ada, bearer } = await office();
    const minted = await ada.send("POST", "/auth/tokens", {
      name: "staging-admin",
      scope: { environments: ["staging"] },
    });
    const staging = bearer(minted.json().token);

    const write = await staging.send("PUT", "/secrets/SMTP?project=office&environment=staging", {
      value: "v1",
    });
    const grant = await staging.send("PUT", "/projects/office/grants", {
      role: "viewer",
      user: ADA.email,
    });
    const unprotect = await staging.send(
      "DELETE",
      "/projects/office/environments/production/protection",
    );
    const deleted = await staging.send("DELETE", "/projects/finance");

    expect(minted.json().scope).toEqual({
      environments: ["staging"],
      projects: null,
      role: "admin",
    });
    expect(write.statusCode).toBe(200);
    for (const refused of [grant, unprotect, deleted]) {
      expect(refused.json()).toMatchObject({
        code: "ACCESS_DENIED",
        details: { required: "admin", role: "editor" },
      });
    }
    expect((await ada.send("GET", "/projects/office/access")).json().protectedEnvironments).toEqual(
      ["production"],
    );
  });

  it("lets a token that reaches admin manage service accounts but never their tokens", async () => {
    const { ada, bearer } = await office();
    const adaToken = bearer((await ada.send("POST", "/auth/tokens", { name: "cli" })).json().token);
    const accounts = "/projects/office/service-accounts";

    const created = await adaToken.send("POST", accounts, { name: "deployer" });
    const listed = await adaToken.send("GET", accounts);
    const minted = await adaToken.send("POST", `${accounts}/deployer/tokens`, { name: "ci" });
    const bySession = await ada.send("POST", `${accounts}/deployer/tokens`, { name: "ci" });
    const rotated = await adaToken.send("POST", `${accounts}/deployer/tokens/ci/rotation`);
    const revoked = await adaToken.send("DELETE", `${accounts}/deployer/tokens/ci`);
    const deleted = await adaToken.send("DELETE", `${accounts}/deployer`);

    expect(created.statusCode).toBe(201);
    expect(listed.json().serviceAccounts).toEqual([
      expect.objectContaining({ createdBy: expect.objectContaining({ name: ADA.name }) }),
    ]);
    expect(bySession.statusCode).toBe(201);
    for (const refused of [minted, rotated, revoked]) {
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "AUTH_SESSION_REQUIRED" });
    }
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ serviceAccount: "deployer", changed: true });
    expect((await ada.send("GET", accounts)).json().serviceAccounts).toEqual([]);
  });

  it("rotates and revokes a service account's token from a session only", async () => {
    const { ada, bearer } = await office();
    await ada.send("POST", "/projects/office/service-accounts", { name: "deployer" });
    await ada.send("PUT", "/projects/office/grants", {
      role: "viewer",
      serviceAccount: "deployer",
    });
    const tokens = "/projects/office/service-accounts/deployer/tokens";
    const first = bearer((await ada.send("POST", tokens, { name: "ci" })).json().token);
    const adaToken = bearer((await ada.send("POST", "/auth/tokens", { name: "cli" })).json().token);

    const mintByToken = await adaToken.send("POST", tokens, { name: "other" });
    const rotated = await ada.send("POST", `${tokens}/ci/rotation`);
    const second = bearer(rotated.json().token);
    const oldAfterRotation = await first.send("GET", "/projects");
    const newAfterRotation = await second.send("GET", "/projects");
    const revoked = await ada.send("DELETE", `${tokens}/ci`);
    const newAfterRevocation = await second.send("GET", "/projects");

    expect(mintByToken.statusCode).toBe(403);
    expect(mintByToken.json()).toMatchObject({ code: "AUTH_SESSION_REQUIRED" });
    expect(rotated.statusCode).toBe(201);
    expect(rotated.json()).toMatchObject({ name: "ci", scope: { role: "editor" } });
    expect(oldAfterRotation.statusCode).toBe(403);
    expect(newAfterRotation.json().projects).toEqual([
      expect.objectContaining({ role: "viewer", slug: "office" }),
    ]);
    expect(revoked.json()).toMatchObject({ name: "ci", revokedAt: expect.any(String) });
    expect(newAfterRevocation.statusCode).toBe(403);
  });
});

// The dashboard's Access tab shows these roles as they are; it never re-derives the production cap.
describe("who may do what in a project", () => {
  it("names each holder's role per environment, capped where the project is protected", async () => {
    const { ada, joined } = await office(MIA);
    const [mia] = joined;
    if (mia === undefined) throw new Error("Mia did not join.");
    const team = (await ada.send("POST", "/teams", { name: "Bookkeeping" })).json();
    await ada.send("PUT", `/teams/${team.id}/members/${mia.id}`);
    await ada.send("PUT", "/projects/office/grants", { role: "editor", team: team.id });
    await ada.send("POST", "/projects/office/service-accounts", { name: "deployer" });
    await ada.send("PUT", "/projects/office/grants", {
      role: "viewer",
      serviceAccount: "deployer",
    });
    const holders = async () => {
      const access = (await ada.send("GET", "/projects/office/access")).json();
      return Object.fromEntries(
        access.holders.map((holder: { name: string; role: string; environments: object }) => [
          holder.name,
          { production: Reflect.get(holder.environments, "production"), role: holder.role },
        ]),
      );
    };

    const before = await holders();
    await ada.send("PUT", "/projects/office/grants", {
      environment: "production",
      role: "operator",
      team: team.id,
    });
    const after = await holders();

    expect(before).toEqual({
      Ada: { production: { cap: "editor", role: "admin" }, role: "admin" },
      Bookkeeping: { production: { cap: null, role: null }, role: "editor" },
      Mia: { production: { cap: null, role: null }, role: "editor" },
      // Release holds production of every new project; it caps a member's project role and gives none.
      Release: { production: { cap: "editor", role: null }, role: null },
      deployer: { production: { cap: null, role: null }, role: "viewer" },
    });
    expect(after).toMatchObject({
      Bookkeeping: { production: { cap: "operator", role: "operator" }, role: "editor" },
      Mia: { production: { cap: "operator", role: "operator" }, role: "editor" },
    });
    // An instance role shows only where it is the reason for access.
    const listed = (await ada.send("GET", "/projects/office/access")).json();
    expect(
      Object.fromEntries(
        listed.holders.map((holder: { name: string; instanceRole: string | null }) => [
          holder.name,
          holder.instanceRole,
        ]),
      ),
    ).toEqual({ Ada: "owner", Bookkeeping: null, Mia: null, Release: null, deployer: null });
    // A protected environment is listed even where the instance names no such environment.
    expect((await ada.send("GET", "/projects/office/access")).json().environments).toContain(
      "production",
    );
    expect((await mia.browser.send("GET", "/projects")).json().projects).toEqual([
      expect.objectContaining({
        protectedEnvironments: ["production"],
        role: "editor",
        slug: "office",
      }),
    ]);
  });
});
