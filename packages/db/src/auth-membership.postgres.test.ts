import type { MailMessage } from "@swizzle/core";
import { describe, expect, it } from "vitest";
import { AuthBrowser } from "../../../test/auth-browser.js";
import { authenticatorCode } from "../../../test/authenticator.js";
import { testDatabase } from "../../../test/postgres.js";
import { testAuth, testHostAuth } from "../../../test/stores.js";
import { RELEASE_TEAM_ID } from "./access.js";
import {
  type AccountEffects,
  INVITATION_TOKEN_HEADER,
  type PendingGrant,
  type SwizzleAuth,
} from "./auth.js";
import { authUsers } from "./schema.js";

const ORIGIN = "http://dashboard.test";
const OWNER = { email: "ada@example.test", name: "Ada", password: "correct horse battery" };
const ANNA = { email: "anna@example.test", name: "Anna", password: "anna's long passphrase" };
const BUERO = "00000000-0000-4000-8000-0000000000b1";
const LAGER = "00000000-0000-4000-8000-0000000000b2";

/**
 * An instance with its first account, a mailbox that keeps every mail, and recorded effects. The
 * grant calls numbered in `grantFails` (from 0) fail once each.
 */
async function instance(options: { readonly grantFails?: readonly number[] } = {}) {
  const mails: MailMessage[] = [];
  const granted: { userId: string; grant: PendingGrant }[] = [];
  const revoked: string[] = [];
  let calls = 0;
  const effects: AccountEffects = {
    async grantProject(userId, grant) {
      calls += 1;
      if (options.grantFails?.includes(calls - 1)) throw new Error("the access store is down");
      granted.push({ grant, userId });
    },
    async revokeTokens(userId) {
      revoked.push(userId);
    },
  };
  const auth = testAuth({
    effects,
    links: { origin: ORIGIN, mailer: { send: async (mail) => void mails.push(mail) } },
    trustedOrigins: [ORIGIN],
  });
  const owner = new AuthBrowser(auth, ORIGIN);
  expect((await owner.post("/sign-up/email", OWNER)).status).toBe(200);
  const ownerId = (await owner.person())?.user.id ?? fail();
  return { auth, granted, mails, owner, ownerId, revoked };
}

/** The token at the end of the last mail's link, as the person who received it reads it. */
function linkToken(mails: readonly MailMessage[], page: "invitation" | "reset-password"): string {
  const text = mails.at(-1)?.text ?? "";
  return new RegExp(`${ORIGIN}/${page}#(\\S+)`, "u").exec(text)?.[1] ?? fail();
}

async function invite(auth: SwizzleAuth, invitedBy: string, role: "admin" | "member" | "owner") {
  return await auth.invite({
    email: ANNA.email,
    grants: [{ projectId: BUERO, role: "editor" }],
    invitedBy,
    role,
  });
}

async function accept(auth: SwizzleAuth, token: string, person = ANNA) {
  const browser = new AuthBrowser(auth, ORIGIN, "198.51.100.20");
  const response = await browser.post("/sign-up/email", person, {
    [INVITATION_TOKEN_HEADER]: token,
  });
  return { browser, response };
}

// Sign-ins hash with production-cost scrypt; see auth.test.ts.
describe("membership", () => {
  it("refuses to mint links without a dashboard origin before storing them", async () => {
    const auth = testAuth({ links: null });
    await new AuthBrowser(auth, ORIGIN).post("/sign-up/email", OWNER);
    const owner = (await auth.listPeople())[0] ?? fail();

    await expect(
      auth.invite({ email: ANNA.email, role: "member", grants: [], invitedBy: owner.id }),
    ).rejects.toMatchObject({ code: "DASHBOARD_ORIGIN_NOT_CONFIGURED" });
    await expect(auth.createResetLink(owner.id, owner.id)).rejects.toMatchObject({
      code: "DASHBOARD_ORIGIN_NOT_CONFIGURED",
    });
    expect(await auth.listInvitations()).toEqual([]);
    expect((await testDatabase().pool.query("SELECT * FROM auth_verifications")).rows).toEqual([]);
  });

  it("lets the invited address join once, with the invited role and grants, and nobody else", async () => {
    const { auth, granted, mails, ownerId } = await instance();
    const sent = await invite(auth, ownerId, "member");
    const token = linkToken(mails, "invitation");
    expect(sent.url).toBe(`${ORIGIN}/invitation#${token}`);

    const otherAddress = await accept(auth, token, { ...ANNA, email: "eve@example.test" });
    const noToken = await new AuthBrowser(auth, ORIGIN).post("/sign-up/email", ANNA);
    const joined = await accept(auth, token);
    const again = await accept(auth, token, { ...ANNA, email: ANNA.email });

    expect(mails.at(-1)).toMatchObject({ subject: "Ada invited you to Swizzle", to: ANNA.email });
    expect(otherAddress.response).toMatchObject({
      body: { error: "AUTH_INVITATION_INVALID" },
      status: 404,
    });
    expect(noToken).toMatchObject({ body: { error: "AUTH_INVITATION_REQUIRED" }, status: 403 });
    expect(joined.response.status).toBe(200);
    const anna = (await joined.browser.person())?.user ?? fail();
    expect(anna).toMatchObject({ email: ANNA.email, role: "member", suspended: false });
    expect(granted).toEqual([{ grant: { projectId: BUERO, role: "editor" }, userId: anna.id }]);
    // Only the first owner joins Release; an invited person is in no team until someone adds them.
    expect(
      (
        await testDatabase().pool.query(
          'SELECT team_id AS "teamId", user_id AS "userId" FROM team_members',
        )
      ).rows,
    ).toEqual([{ teamId: RELEASE_TEAM_ID, userId: ownerId }]);
    expect(again.response.status).toBeGreaterThanOrEqual(400);
    expect(await auth.findInvitation(token)).toBeNull();
    expect(await auth.listInvitations()).toEqual([]);
  });

  it("gives a grant that failed at the next sign-in, and never one it gave already", async () => {
    // The second grant fails at sign-up. Whatever an admin did to the first since, the next
    // sign-in gives only the second.
    const { auth, granted, mails, ownerId } = await instance({ grantFails: [1] });
    await auth.invite({
      email: ANNA.email,
      grants: [
        { projectId: BUERO, role: "editor" },
        { projectId: LAGER, role: "viewer" },
      ],
      invitedBy: ownerId,
      role: "member",
    });

    const joined = await accept(auth, linkToken(mails, "invitation"));
    expect(joined.response.status).toBe(200);
    expect(granted.map(({ grant }) => grant.projectId)).toEqual([BUERO]);

    const later = new AuthBrowser(auth, ORIGIN, "198.51.100.20");
    await later.post("/sign-in/email", { email: ANNA.email, password: ANNA.password });
    await later.post("/sign-in/email", { email: ANNA.email, password: ANNA.password });

    expect(granted.map(({ grant }) => grant.projectId)).toEqual([BUERO, LAGER]);
  });

  it("replaces an invitation's link with the next one to the same address", async () => {
    const { auth, mails, ownerId } = await instance();
    await invite(auth, ownerId, "member");
    const first = linkToken(mails, "invitation");
    await invite(auth, ownerId, "admin");
    const second = linkToken(mails, "invitation");

    expect((await accept(auth, first)).response.status).toBe(404);
    const joined = await accept(auth, second);
    expect((await joined.browser.person())?.user.role).toBe("admin");
  });

  it("leaves exactly one working link when two invitations to one address go out at once", async () => {
    const mails: MailMessage[] = [];
    let release = () => {};
    const bothSending = new Promise<void>((resolve) => {
      let sending = 0;
      release = () => {
        sending += 1;
        if (sending === 2) resolve();
      };
    });
    const auth = testAuth({
      links: {
        origin: ORIGIN,
        mailer: {
          async send(mail) {
            mails.push(mail);
            release();
            await bothSending;
          },
        },
      },
      trustedOrigins: [ORIGIN],
    });
    const owner = new AuthBrowser(auth, ORIGIN);
    await owner.post("/sign-up/email", OWNER);
    const ownerId = (await owner.person())?.user.id ?? fail();

    await Promise.all([invite(auth, ownerId, "member"), invite(auth, ownerId, "admin")]);

    const tokens = mails.map((mail) => /invitation#(\S+)/u.exec(mail.text)?.[1] ?? fail());
    const working = await Promise.all(tokens.map((token) => auth.findInvitation(token)));
    expect(working.filter((invitation) => invitation !== null)).toHaveLength(1);
    expect(await auth.listInvitations()).toHaveLength(1);
  });

  it("judges a change by the actor's and the person's roles as they are when it runs", async () => {
    const { auth, mails, ownerId } = await instance();
    await invite(auth, ownerId, "admin");
    const bert = await accept(auth, linkToken(mails, "invitation"));
    const bertId = (await bert.browser.person())?.user.id ?? fail();
    await auth.invite({
      email: "carl@example.test",
      grants: [],
      invitedBy: ownerId,
      role: "member",
    });
    const carl = await accept(auth, linkToken(mails, "invitation"), {
      ...ANNA,
      email: "carl@example.test",
      name: "Carl",
    });
    const carlId = (await carl.browser.person())?.user.id ?? fail();
    const denied = { code: "ACCESS_DENIED" };

    // An owner promotes Carl; the admin's change to him is refused from then on.
    await auth.setRole(ownerId, carlId, "owner");
    await expect(auth.setSuspended(bertId, carlId, true)).rejects.toMatchObject(denied);
    await expect(auth.resetTwoFactor(bertId, ownerId)).rejects.toMatchObject(denied);
    // An owner demotes Carl and then the admin; the former admin can change nobody.
    await auth.setRole(ownerId, carlId, "member");
    await auth.setRole(ownerId, bertId, "member");
    await expect(auth.setSuspended(bertId, carlId, true)).rejects.toMatchObject(denied);
    expect(await auth.findPerson(carlId)).toMatchObject({ role: "member", suspended: false });
  });

  it("keeps the last active owner, counting a suspended owner out", async () => {
    const { auth, mails, ownerId } = await instance();
    const lastOwner = { code: "AUTH_LAST_OWNER" };

    await expect(auth.setRole(ownerId, ownerId, "admin")).rejects.toMatchObject(lastOwner);
    await expect(auth.setSuspended(ownerId, ownerId, true)).rejects.toMatchObject(lastOwner);
    await expect(auth.removePerson(ownerId, ownerId)).rejects.toMatchObject(lastOwner);

    await invite(auth, ownerId, "owner");
    const anna = await accept(auth, linkToken(mails, "invitation"));
    const annaId = (await anna.browser.person())?.user.id ?? fail();
    await auth.setSuspended(ownerId, annaId, true);
    await expect(auth.setRole(ownerId, ownerId, "member")).rejects.toMatchObject(lastOwner);

    await auth.setSuspended(ownerId, annaId, false);
    expect(await auth.setRole(ownerId, ownerId, "member")).toMatchObject({ role: "member" });
    await expect(auth.removePerson(annaId, annaId)).rejects.toMatchObject(lastOwner);
  });

  it("ends a suspended person's sessions at once and refuses their sign-in until reactivated", async () => {
    const { auth, mails, ownerId } = await instance();
    await invite(auth, ownerId, "member");
    const anna = await accept(auth, linkToken(mails, "invitation"));
    const annaId = (await anna.browser.person())?.user.id ?? fail();

    expect(await auth.setSuspended(ownerId, annaId, true)).toMatchObject({ suspended: true });
    const browser = new AuthBrowser(auth, ORIGIN, "198.51.100.21");
    const wrongPassword = await browser.post("/sign-in/email", {
      email: ANNA.email,
      password: "not her password at all",
    });
    const rightPassword = await browser.post("/sign-in/email", {
      email: ANNA.email,
      password: ANNA.password,
    });

    expect(await anna.browser.person()).toBeNull();
    expect(await auth.findPerson(annaId)).toMatchObject({ suspended: true });
    expect(wrongPassword).toMatchObject({ body: { error: "AUTH_INVALID_CREDENTIALS" } });
    expect(rightPassword).toMatchObject({ body: { error: "AUTH_ACCOUNT_SUSPENDED" }, status: 403 });
    expect(await browser.person()).toBeNull();

    await auth.setSuspended(ownerId, annaId, false);
    await browser.post("/sign-in/email", { email: ANNA.email, password: ANNA.password });
    expect(await browser.person()).not.toBeNull();
  });

  it("resets a forgotten password by mail once, ending sessions and tokens, with no usable token stored", async () => {
    const { auth, mails, owner, ownerId, revoked } = await instance();

    const asked = await new AuthBrowser(auth, ORIGIN).post("/request-password-reset", {
      email: OWNER.email,
    });
    const token = linkToken(mails, "reset-password");
    const reset = await new AuthBrowser(auth, ORIGIN).post("/reset-password", {
      newPassword: "a brand new long passphrase",
      token,
    });
    const reused = await new AuthBrowser(auth, ORIGIN).post("/reset-password", {
      newPassword: "yet another long passphrase",
      token,
    });
    const fresh = new AuthBrowser(auth, ORIGIN);
    await fresh.post("/sign-in/email", {
      email: OWNER.email,
      password: "a brand new long passphrase",
    });

    expect(asked.status).toBe(200);
    expect(reset.status).toBe(200);
    expect(reused.status).toBe(400);
    expect(await owner.person()).toBeNull();
    expect(await fresh.person()).not.toBeNull();
    expect(revoked).toEqual([ownerId]);
    expect(
      JSON.stringify((await testDatabase().pool.query("SELECT * FROM auth_verifications")).rows),
    ).not.toContain(token);
  });

  it("turns a lost second factor off so the person signs in with the password again", async () => {
    const { auth, owner, ownerId } = await instance();
    const enabled = await owner.post("/two-factor/enable", { password: OWNER.password });
    const secret = new URL(String(enabled.body?.totpURI)).searchParams.get("secret") ?? fail();
    await owner.post("/two-factor/verify-totp", { code: authenticatorCode(secret) });
    const signIn = () =>
      new AuthBrowser(auth, ORIGIN).post("/sign-in/email", {
        email: OWNER.email,
        password: OWNER.password,
      });
    expect((await signIn()).body).toMatchObject({ twoFactorRedirect: true });

    expect(await auth.resetTwoFactor(ownerId, ownerId)).toBe(true);

    expect(await owner.person()).toBeNull();
    expect((await signIn()).body).not.toHaveProperty("twoFactorRedirect");
    expect(await auth.resetTwoFactor(ownerId, ownerId)).toBe(false);
  });

  it("hands out a reset link that works once and sends no mail; none for an owner by an admin, none for oneself", async () => {
    const { auth, mails, owner, ownerId, revoked } = await instance();
    await invite(auth, ownerId, "admin");
    const { browser: anna } = await accept(auth, linkToken(mails, "invitation"));
    const annaId = (await anna.person())?.user.id ?? fail();
    const mailsBefore = mails.length;

    const link = (await auth.createResetLink(ownerId, annaId)) ?? fail();
    const newPassword = "anna's chosen new passphrase";
    const reset = await new AuthBrowser(auth, ORIGIN).post("/reset-password", {
      newPassword,
      token: new URL(link.url).hash.slice(1),
    });
    const reused = await new AuthBrowser(auth, ORIGIN).post("/reset-password", {
      newPassword: "a second new long passphrase",
      token: new URL(link.url).hash.slice(1),
    });
    const fresh = new AuthBrowser(auth, ORIGIN);
    await fresh.post("/sign-in/email", { email: ANNA.email, password: newPassword });

    expect(reset.status).toBe(200);
    expect(reused.status).toBe(400);
    expect(mails.length).toBe(mailsBefore);
    expect(await anna.person()).toBeNull();
    expect((await fresh.person())?.user.id).toBe(annaId);
    expect(revoked).toEqual([annaId]);
    await expect(auth.createResetLink(annaId, ownerId)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(auth.createResetLink(ownerId, ownerId)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(await auth.createResetLink(ownerId, crypto.randomUUID())).toBeNull();
    expect(await owner.person()).not.toBeNull();
  });

  it("lets the host recover an owner who lost password and authenticator, without mail", async () => {
    const revoked: string[] = [];
    const effects: AccountEffects = {
      grantProject: async () => {},
      revokeTokens: async (userId) => void revoked.push(userId),
    };
    const auth = testAuth({ effects, trustedOrigins: [ORIGIN] });
    const host = testHostAuth();
    const owner = new AuthBrowser(auth, ORIGIN);
    await owner.post("/sign-up/email", OWNER);
    const ownerId = (await owner.person())?.user.id ?? fail();
    const enabled = await owner.post("/two-factor/enable", { password: OWNER.password });
    const totp = new URL(String(enabled.body?.totpURI)).searchParams.get("secret") ?? fail();
    await owner.post("/two-factor/verify-totp", { code: authenticatorCode(totp) });

    expect(await host.recoverOwner(ANNA.email)).toEqual({
      kind: "not-an-owner",
      owners: [OWNER.email],
    });
    const recovery = await host.recoverOwner(" ADA@example.test ");
    if (recovery.kind !== "recovered") return fail();
    const newPassword = "the owner's new long passphrase";
    const reset = await new AuthBrowser(auth, ORIGIN).post("/reset-password", {
      newPassword,
      token: new URL(recovery.link.url).hash.slice(1),
    });
    const reused = await new AuthBrowser(auth, ORIGIN).post("/reset-password", {
      newPassword: "a second new long passphrase",
      token: new URL(recovery.link.url).hash.slice(1),
    });
    const fresh = new AuthBrowser(auth, ORIGIN);
    const signIn = await fresh.post("/sign-in/email", {
      email: OWNER.email,
      password: newPassword,
    });

    expect(recovery).toMatchObject({ email: OWNER.email, userId: ownerId });
    expect(new URL(recovery.link.url).origin).toBe(ORIGIN);
    expect(new URL(recovery.link.url).pathname).toBe("/reset-password");
    expect(await owner.person()).toBeNull();
    expect(reset.status).toBe(200);
    expect(reused.status).toBe(400);
    expect(signIn.body).not.toHaveProperty("twoFactorRedirect");
    expect((await fresh.person())?.user).toMatchObject({ id: ownerId, twoFactorEnabled: false });
    expect(revoked).toEqual([ownerId]);
    expect(
      JSON.stringify((await testDatabase().pool.query("SELECT * FROM auth_verifications")).rows),
    ).not.toContain(new URL(recovery.link.url).hash.slice(1));
  });

  it("finds an owner for host recovery past the adapter's 100-row page", async () => {
    testAuth();
    const now = new Date();
    const emails = Array.from(
      { length: 101 },
      (_, index) => `owner-${String(index).padStart(3, "0")}@example.test`,
    );
    for (const email of emails) {
      await testDatabase().db.insert(authUsers).values({
        createdAt: now,
        email,
        emailVerified: true,
        id: crypto.randomUUID(),
        name: email,
        role: "owner",
        twoFactorEnabled: false,
        updatedAt: now,
      });
    }
    const host = testHostAuth();

    expect(await host.recoverOwner("owner-100@example.test")).toMatchObject({
      kind: "recovered",
      email: "owner-100@example.test",
    });
    expect(await host.recoverOwner(ANNA.email)).toEqual({ kind: "not-an-owner", owners: emails });
  });
});

function fail(): never {
  throw new Error("expected a value");
}
