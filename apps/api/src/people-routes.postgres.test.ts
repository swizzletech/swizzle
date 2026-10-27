import type { MailMessage } from "@swizzle/core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";
import { DASHBOARD_ORIGIN, testBrowser } from "../test/browser.js";
import { buildTestServer } from "../test/server-harness.js";

const ADA = { email: "ada@example.com", name: "Ada", password: "correct horse battery staple" };
const ANNA = { email: "anna@example.com", name: "Anna", password: "anna's long passphrase" };
const BERT = { email: "bert@example.com", name: "Bert", password: "bert's long passphrase" };

beforeEach(() => {
  vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", DASHBOARD_ORIGIN);
  vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
});

/**
 * A server whose owner Ada is signed in, with a mailbox that keeps every mail it sends, or with no
 * mail server when `mail` is false.
 */
async function instance({ mail = true } = {}) {
  const mails: MailMessage[] = [];
  const app = await buildTestServer(
    mail
      ? {
          links: {
            origin: DASHBOARD_ORIGIN,
            mailer: { send: async (message) => void mails.push(message) },
          },
        }
      : {},
  );
  onTestFinished(() => app.close());
  const ada = testBrowser(app);
  expect((await ada.send("POST", "/auth/sign-up/email", ADA)).statusCode).toBe(200);
  const adaId: string = (await ada.send("GET", "/auth/status")).json().user.id;

  /** Sends an invitation as `from` and returns the token its mail carries. */
  const invite = async (from: typeof ada, body: object) => {
    const sent = await from.send("POST", "/invitations", body);
    const token = new RegExp(`${DASHBOARD_ORIGIN}/invitation#(\\S+)`, "u").exec(
      mails.at(-1)?.text ?? "",
    )?.[1];
    return { sent, token: token ?? "" };
  };
  /** Accepts an invitation in a fresh browser, as the person the mail reached. */
  const join = async (person: typeof ANNA, token: string) => {
    const browser = testBrowser(app, "198.51.100.20");
    const joined = await browser.send("POST", "/auth/sign-up/email", person, {
      "x-swizzle-invitation-token": token,
    });
    expect(joined.statusCode).toBe(200);
    const id: string = (await browser.send("GET", "/auth/status")).json().user.id;
    return { browser, id };
  };
  return { ada, adaId, app, invite, join, mails };
}

// Sign-ins hash with production-cost scrypt; see sign-in.test.ts.
describe("people over HTTP", { timeout: 30_000 }, () => {
  it("admits only an invited address, which lands in the projects it was invited to", async () => {
    const { ada, app, invite, join, mails } = await instance();
    await ada.send("POST", "/projects", { name: "Büro", slug: "buero" });

    const { sent, token } = await invite(ada, {
      email: ANNA.email,
      projects: [{ project: "buero", role: "editor" }],
      role: "member",
    });
    const stranger = await testBrowser(app).send("POST", "/auth/sign-up/email", ANNA);
    const offer = await testBrowser(app).send("POST", "/auth/invitation", { token });
    const anna = await join(ANNA, token);
    const projects = await anna.browser.send("GET", "/projects");
    const pending = await ada.send("GET", "/invitations");

    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({
      mailed: true,
      url: `${DASHBOARD_ORIGIN}/invitation#${token}`,
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ subject: "Ada invited you to Swizzle", to: ANNA.email });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json()).toMatchObject({ error: "AUTH_INVITATION_REQUIRED" });
    expect(offer.json()).toMatchObject({
      email: ANNA.email,
      invitedBy: "Ada",
      projects: [{ project: { name: "Büro", slug: "buero" }, role: "editor" }],
      role: "member",
    });
    expect(projects.json().projects).toMatchObject([{ name: "Büro", role: "editor" }]);
    expect(pending.json()).toEqual({ invitations: [] });
  });

  it("without a mail server answers with the invitation's link, which creates the account once", async () => {
    const { ada, app, join } = await instance({ mail: false });

    const sent = await ada.send("POST", "/invitations", { email: ANNA.email, role: "admin" });
    const { mailed, url } = sent.json();
    const token = url.slice(`${DASHBOARD_ORIGIN}/invitation#`.length);
    const anna = await join(ANNA, token);
    const again = await testBrowser(app).send("POST", "/auth/sign-up/email", ANNA, {
      "x-swizzle-invitation-token": token,
    });
    const signIn = await testBrowser(app, "198.51.100.30").send("POST", "/auth/sign-in/email", {
      email: ANNA.email,
      password: ANNA.password,
    });

    expect(sent.statusCode).toBe(201);
    expect(mailed).toBe(false);
    expect(url).toMatch(new RegExp(`^${DASHBOARD_ORIGIN}/invitation#swzi_`, "u"));
    expect((await anna.browser.send("GET", "/auth/status")).json().user).toMatchObject({
      email: ANNA.email,
      role: "admin",
    });
    expect(again.json()).toMatchObject({ error: "AUTH_INVITATION_INVALID" });
    expect(signIn.statusCode).toBe(200);
  });

  it("leaves owners to owners and keeps the last one", async () => {
    const { ada, adaId, invite, join } = await instance();
    const bert = await join(BERT, (await invite(ada, { email: BERT.email, role: "admin" })).token);

    const demoteByAdmin = await bert.browser.send("PUT", `/users/${adaId}/role`, { role: "admin" });
    const ownerByAdmin = await bert.browser.send("POST", "/invitations", {
      email: ANNA.email,
      role: "owner",
    });
    const demoteSelf = await ada.send("PUT", `/users/${adaId}/role`, { role: "admin" });
    const removeSelf = await ada.send("DELETE", `/users/${adaId}`);
    const promote = await ada.send("PUT", `/users/${bert.id}/role`, { role: "owner" });
    const demoteNow = await ada.send("PUT", `/users/${adaId}/role`, { role: "admin" });

    expect(demoteByAdmin.statusCode).toBe(403);
    expect(ownerByAdmin.statusCode).toBe(403);
    expect(demoteSelf.statusCode).toBe(409);
    expect(demoteSelf.json()).toMatchObject({ error: "AUTH_LAST_OWNER" });
    expect(removeSelf.statusCode).toBe(409);
    expect(promote.json()).toMatchObject({ role: "owner" });
    expect(demoteNow.json()).toMatchObject({ role: "admin" });
  });

  it("stops a suspended person's session and token at once, and a removed one's for good", async () => {
    const { ada, app, invite, join } = await instance();
    const anna = await join(ANNA, (await invite(ada, { email: ANNA.email, role: "member" })).token);
    const minted = await anna.browser.send("POST", "/auth/tokens", { name: "laptop" });
    const withToken = () =>
      app.inject({
        headers: { authorization: `Bearer ${minted.json().token}` },
        method: "GET",
        url: "/projects",
      });
    expect((await withToken()).statusCode).toBe(200);

    const suspended = await ada.send("PUT", `/users/${anna.id}/suspension`);
    const sessionWhileSuspended = await anna.browser.send("GET", "/projects");
    const tokenWhileSuspended = await withToken();
    const listed = await ada.send("GET", "/users");
    await ada.send("DELETE", `/users/${anna.id}/suspension`);
    const tokenReactivated = await withToken();
    const removed = await ada.send("DELETE", `/users/${anna.id}`);
    const tokenRemoved = await withToken();

    expect(suspended.json()).toMatchObject({ suspended: true });
    expect(sessionWhileSuspended.statusCode).toBe(401);
    expect(tokenWhileSuspended.statusCode).toBe(403);
    // A suspended person cannot mint a replacement, so the refusal says whom to ask instead.
    expect(tokenWhileSuspended.json()).toEqual({
      code: "AUTH_ACCOUNT_SUSPENDED",
      error: "AUTH_ACCOUNT_SUSPENDED",
      fixCommand:
        "Ask an owner or admin of this instance to lift the suspension in Settings > People.",
      message: "The person this API token belongs to is suspended.",
    });
    expect(listed.json().users).toContainEqual(
      expect.objectContaining({ email: ANNA.email, suspended: true }),
    );
    expect(tokenReactivated.statusCode).toBe(200);
    expect(removed.statusCode).toBe(204);
    expect(tokenRemoved.statusCode).toBe(403);
    expect(tokenRemoved.json()).toMatchObject({ error: "FORBIDDEN" });
  });

  it("hands an owner a reset link for a person once, to the owner alone, and audits it without the token", async () => {
    const { ada, app, invite, join } = await instance();
    const anna = await join(ANNA, (await invite(ada, { email: ANNA.email, role: "member" })).token);

    const anonymous = await testBrowser(app).send("POST", `/users/${anna.id}/reset-link`);
    const byMember = await anna.browser.send("POST", `/users/${anna.id}/reset-link`);
    const created = await ada.send("POST", `/users/${anna.id}/reset-link`);
    const { url } = created.json() as { url: string };
    const token = new URL(url).hash.slice(1);
    const reset = await testBrowser(app).send("POST", "/auth/reset-password", {
      newPassword: "anna's chosen new passphrase",
      token,
    });
    const reused = await testBrowser(app).send("POST", "/auth/reset-password", {
      newPassword: "someone else's new passphrase",
      token,
    });
    const signIn = await testBrowser(app).send("POST", "/auth/sign-in/email", {
      email: ANNA.email,
      password: "anna's chosen new passphrase",
    });
    const audit = await ada.send("GET", "/audit");

    expect(anonymous.statusCode).toBe(401);
    expect(byMember.statusCode).toBe(403);
    expect(created.statusCode).toBe(201);
    expect(url.startsWith(`${DASHBOARD_ORIGIN}/reset-password#`)).toBe(true);
    expect(reset.statusCode).toBe(200);
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toMatchObject({ error: "AUTH_RESET_LINK_INVALID" });
    expect(signIn.statusCode).toBe(200);
    expect(audit.json().events).toContainEqual(
      expect.objectContaining({
        action: "POST /users/:userId/reset-link",
        params: { userId: anna.id },
        status: 201,
      }),
    );
    expect(audit.body).not.toContain(token);
  });
});
