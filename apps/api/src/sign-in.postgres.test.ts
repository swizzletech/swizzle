import { FULL_SCOPE } from "@swizzle/db";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { authenticatorCode } from "../../../test/authenticator.js";
import { testApiTokenStore, testAuth } from "../../../test/stores.js";
import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";
import { DASHBOARD_ORIGIN, testBrowser } from "../test/browser.js";
import { buildTestServer } from "../test/server-harness.js";

const PERSON = { email: "ada@example.com", name: "Ada", password: "correct horse battery staple" };
const SETUP_TOKEN = "setup-token-at-least-thirty-two-bytes-long";

beforeEach(() => {
  vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", DASHBOARD_ORIGIN);
  vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
});

/** A server whose first account needs SETUP_TOKEN, closed when the test finishes. */
async function server() {
  const apiTokenStore = testApiTokenStore();
  const app = await buildTestServer({
    apiTokenStore,
    auth: testAuth({
      setupToken: SETUP_TOKEN,
      trustedOrigins: [DASHBOARD_ORIGIN],
    }),
  });
  onTestFinished(() => app.close());
  return { apiTokenStore, app };
}

async function setUp(app: Awaited<ReturnType<typeof server>>["app"]) {
  const browser = testBrowser(app);
  const created = await browser.send("POST", "/auth/sign-up/email", PERSON, {
    "x-swizzle-setup-token": SETUP_TOKEN,
  });
  expect(created.statusCode).toBe(200);
  return browser;
}

// Sign-in hashes with production-cost scrypt, about 180 ms per hash on an idle core; 30 s leaves
// room for parallel worktrees on a loaded machine.
describe("sign-in over HTTP", { timeout: 30_000 }, () => {
  it("returns the public fallback for an unmapped library validation failure", async () => {
    const auth = testAuth({ trustedOrigins: [DASHBOARD_ORIGIN] });
    const handled = vi.spyOn(auth, "handle");
    const app = await buildTestServer({ auth });
    onTestFinished(() => app.close());
    const response = await testBrowser(app).send("POST", "/auth/sign-in/email", {});
    const answer = await handled.mock.results[0]?.value;

    expect(answer).toMatchObject({ ok: false, error: "AUTH_REQUEST_INVALID", status: 400 });
    expect(response.statusCode).toBe(answer?.status);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "AUTH_REQUEST_INVALID",
      error: "AUTH_REQUEST_INVALID",
      message: "The authentication request failed. Check your input and try again.",
    });
  });

  it("explains how to replace an invalid password reset link", async () => {
    const { app } = await server();
    const response = await testBrowser(app).send("POST", "/auth/reset-password", {
      token: "invalid-reset-token",
      newPassword: "a new long passphrase",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "AUTH_RESET_LINK_INVALID",
      error: "AUTH_RESET_LINK_INVALID",
      message: "This password reset link is invalid or expired. Request a new password reset link.",
    });
  });

  it("answers sign-in and two-factor enrollment with the results the dashboard reads", async () => {
    const { app } = await server();
    await setUp(app);
    const laptop = testBrowser(app);
    const signedIn = await laptop.signIn(PERSON.email, PERSON.password);
    const enabled = await laptop.send("POST", "/auth/two-factor/enable", {
      password: PERSON.password,
    });
    const secret = new URL(enabled.json().totpURI).searchParams.get("secret") ?? "";
    await laptop.send("POST", "/auth/two-factor/verify-totp", { code: authenticatorCode(secret) });
    const challenged = await testBrowser(app).signIn(PERSON.email, PERSON.password);

    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.headers["set-cookie"]).toContainEqual(
      expect.stringMatching(/^swizzle\.session_token=/u),
    );
    expect(signedIn.json()).toMatchObject({
      user: { email: PERSON.email, name: PERSON.name, twoFactorEnabled: false },
    });
    expect(enabled.json()).toMatchObject({
      backupCodes: expect.arrayContaining([expect.any(String)]),
      totpURI: expect.stringMatching(/^otpauth:\/\/totp\/Swizzle:/u),
    });
    expect(challenged.statusCode).toBe(200);
    expect(challenged.json()).toMatchObject({ twoFactorRedirect: true });
    expect(challenged.json()).not.toHaveProperty("user");
  });

  it("keeps factor and sign-out cookies usable across forwarded auth actions", async () => {
    const { app } = await server();
    const laptop = await setUp(app);
    const enrollment = await laptop.send("POST", "/auth/two-factor/enable", {
      password: PERSON.password,
    });
    const { backupCodes, totpURI } = enrollment.json();
    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    const confirmed = await laptop.send("POST", "/auth/two-factor/verify-totp", {
      code: authenticatorCode(secret),
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ success: true });
    expect((await laptop.send("GET", "/auth/status")).json()).toMatchObject({
      authenticated: true,
      user: { email: PERSON.email, twoFactorEnabled: true },
    });

    const signedOut = await laptop.send("POST", "/auth/sign-out", {});
    expect(signedOut.statusCode).toBe(200);
    expect(signedOut.json()).toEqual({ success: true });
    expect((await laptop.send("GET", "/auth/status")).json().authenticated).toBe(false);
    expect(signedOut.headers["set-cookie"]).toContainEqual(
      expect.stringMatching(/^swizzle\.session_token=;.*Max-Age=0/iu),
    );

    const challenged = await laptop.signIn(PERSON.email, PERSON.password);
    expect(challenged.json()).toEqual({ twoFactorRedirect: true });
    const verified = await laptop.send("POST", "/auth/two-factor/verify-backup-code", {
      code: backupCodes[0],
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ success: true });
    expect(verified.headers["set-cookie"]).toContainEqual(
      expect.stringMatching(/^swizzle\.session_token=/u),
    );
    const disabled = await laptop.send("POST", "/auth/two-factor/disable", {
      password: PERSON.password,
      code: backupCodes[1],
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ success: true });
    expect((await laptop.send("GET", "/auth/status")).json()).toMatchObject({
      authenticated: true,
      user: { email: PERSON.email, twoFactorEnabled: false },
    });
  });

  it("sets up the first account with the setup token and signs that browser in", async () => {
    const { app } = await server();
    const browser = testBrowser(app);

    const before = await browser.send("GET", "/auth/status");
    const wrongToken = await browser.send("POST", "/auth/sign-up/email", PERSON, {
      "x-swizzle-setup-token": "a guess",
    });
    const created = await browser.send("POST", "/auth/sign-up/email", PERSON, {
      "x-swizzle-setup-token": SETUP_TOKEN,
    });
    const after = await browser.send("GET", "/auth/status");
    const guarded = await browser.send("GET", "/environments");
    const again = await testBrowser(app).send("POST", "/auth/sign-up/email", PERSON, {
      "x-swizzle-setup-token": SETUP_TOKEN,
    });

    expect(before.json()).toEqual({
      authenticated: false,
      mailConfigured: false,
      setupRequired: true,
      setupTokenRequired: true,
      user: null,
    });
    expect(wrongToken.statusCode).toBe(403);
    expect(wrongToken.json()).toMatchObject({ error: "AUTH_SETUP_TOKEN_INVALID" });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ success: true });
    const setCookies = [created.headers["set-cookie"] ?? []].flat();
    expect(setCookies.find((cookie) => cookie.startsWith("swizzle.session_token="))).toMatch(
      /HttpOnly.*SameSite=Lax/iu,
    );
    expect(setCookies.some((cookie) => cookie.startsWith("swizzle.device="))).toBe(true);
    expect(after.json()).toMatchObject({
      authenticated: true,
      setupRequired: false,
      user: { email: PERSON.email, name: "Ada", twoFactorEnabled: false },
    });
    expect(guarded.statusCode).toBe(200);
    expect(again.statusCode).toBe(403);
    expect(again.json()).toMatchObject({ error: "AUTH_INVITATION_REQUIRED" });
  });

  it("refuses sign-in from a foreign page and from no page", async () => {
    const { app } = await server();
    await setUp(app);

    const foreign = await testBrowser(app).send("POST", "/auth/sign-in/email", PERSON, {
      origin: "https://evil.example",
    });
    const noPage = await app.inject({
      method: "POST",
      payload: { email: PERSON.email, password: PERSON.password },
      url: "/auth/sign-in/email",
    });

    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: "AUTH_ORIGIN_FORBIDDEN" });
    expect(noPage.statusCode).toBe(403);
  });

  it("answers a wrong password in Swizzle's error shape and refuses the sixth with Retry-After", async () => {
    const { app } = await server();
    await setUp(app);
    const stranger = testBrowser(app, "198.51.100.7");

    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await stranger.signIn(PERSON.email, "wrong password guess")).statusCode);
    }
    const wrong = await stranger.signIn(PERSON.email, "wrong password guess");

    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect(wrong.statusCode).toBe(429);
    expect(Number(wrong.headers["retry-after"])).toBeGreaterThan(0);
    expect(wrong.json()).toMatchObject({ error: "AUTH_RATE_LIMITED" });
    const first = await testBrowser(app, "198.51.100.8").signIn(
      "nobody@example.com",
      "x".repeat(20),
    );
    expect(first.json()).toEqual({
      code: "AUTH_INVALID_CREDENTIALS",
      error: "AUTH_INVALID_CREDENTIALS",
      message: "The email or password is incorrect. Check both and try signing in again.",
    });
  });

  it("asks for the code after the password and lets a code open one session", async () => {
    vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z"), toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { app } = await server();
    const owner = await setUp(app);
    const enabled = await owner.send("POST", "/auth/two-factor/enable", {
      password: PERSON.password,
    });
    const secret = new URL(enabled.json().totpURI).searchParams.get("secret") ?? "";
    await owner.send("POST", "/auth/two-factor/verify-totp", { code: authenticatorCode(secret) });
    vi.setSystemTime(new Date("2030-01-01T00:00:30Z"));
    const code = authenticatorCode(secret);

    const laptop = testBrowser(app);
    const challenged = await laptop.signIn(PERSON.email, PERSON.password);
    const beforeCode = await laptop.send("GET", "/environments");
    const verified = await laptop.send("POST", "/auth/two-factor/verify-totp", { code });
    const afterCode = await laptop.send("GET", "/environments");
    const phone = testBrowser(app);
    await phone.signIn(PERSON.email, PERSON.password);
    const reused = await phone.send("POST", "/auth/two-factor/verify-totp", { code });

    expect(enabled.json()).toMatchObject({ backupCodes: expect.any(Array) });
    expect(challenged.json()).toMatchObject({ twoFactorRedirect: true });
    expect(beforeCode.statusCode).toBe(401);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ success: true });
    expect(afterCode.statusCode).toBe(200);
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toMatchObject({ error: "AUTH_CODE_INVALID" });
    expect((await phone.send("GET", "/environments")).statusCode).toBe(401);
  });

  it("lists sessions, revokes one by id, and signs out", async () => {
    const { app } = await server();
    const laptop = await setUp(app);
    const phone = testBrowser(app);
    await phone.signIn(PERSON.email, PERSON.password);

    const listed = await laptop.send("GET", "/auth/sessions");
    const sessions = listed.json().sessions as { current: boolean; id: string }[];
    const phoneSession = sessions.find((session) => !session.current);
    const revoked = await laptop.send("DELETE", `/auth/sessions/${phoneSession?.id}`);
    const unknown = await laptop.send("DELETE", `/auth/sessions/${crypto.randomUUID()}`);
    const phoneAfter = await phone.send("GET", "/environments");
    const laptopAfter = await laptop.send("GET", "/environments");
    await laptop.send("POST", "/auth/sign-out", {});
    const signedOut = await laptop.send("GET", "/auth/status");

    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    expect(listed.body).not.toContain("token");
    expect(revoked.statusCode).toBe(204);
    expect(unknown.statusCode).toBe(404);
    expect(phoneAfter.statusCode).toBe(401);
    expect(laptopAfter.statusCode).toBe(200);
    expect(signedOut.json()).toMatchObject({ authenticated: false });
  });

  it("keeps browser-only routes from bearer tokens and mints a CLI token from a session", async () => {
    const { apiTokenStore, app } = await server();
    const browser = await setUp(app);
    const status = await browser.send("GET", "/auth/status");
    const machine = await apiTokenStore.createToken({
      holder: { kind: "person", userId: status.json().user.id },
      issuedBy: { id: status.json().user.id, name: "owner" },
      name: "agent",
      scope: FULL_SCOPE,
    });
    const bearer = { authorization: `Bearer ${machine.token}` };

    const changeWithToken = await app.inject({
      headers: bearer,
      method: "POST",
      payload: { currentPassword: PERSON.password, newPassword: "x".repeat(20) },
      url: "/auth/change-password",
    });
    const mintWithToken = await app.inject({
      headers: bearer,
      method: "POST",
      payload: { name: "ci" },
      url: "/auth/tokens",
    });
    const minted = await browser.send("POST", "/auth/tokens", { name: "laptop-cli" });
    const cli = await app.inject({
      headers: { authorization: `Bearer ${minted.json().token}` },
      method: "GET",
      url: "/environments",
    });

    expect(changeWithToken.statusCode).toBe(403);
    expect(changeWithToken.json()).toMatchObject({ error: "AUTH_SESSION_REQUIRED" });
    expect(mintWithToken.statusCode).toBe(403);
    expect(minted.statusCode).toBe(201);
    expect(cli.statusCode).toBe(200);
  });

  it("signs every other browser out when the password changes", async () => {
    const { app } = await server();
    const laptop = await setUp(app);
    const phone = testBrowser(app);
    await phone.signIn(PERSON.email, PERSON.password);
    const newPassword = "a brand new passphrase";

    const wrong = await laptop.send("POST", "/auth/change-password", {
      currentPassword: "not the password at all",
      newPassword,
    });
    const changed = await laptop.send("POST", "/auth/change-password", {
      currentPassword: PERSON.password,
      newPassword,
    });

    expect(wrong.json()).toMatchObject({ error: "AUTH_CURRENT_PASSWORD_INVALID" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ success: true });
    expect((await laptop.send("GET", "/environments")).statusCode).toBe(200);
    expect((await phone.send("GET", "/environments")).statusCode).toBe(401);
    expect((await testBrowser(app).signIn(PERSON.email, newPassword)).statusCode).toBe(200);
  });
});
