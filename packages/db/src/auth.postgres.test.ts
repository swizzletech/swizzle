import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthBrowser, SESSION_COOKIE } from "../../../test/auth-browser.js";
import { authenticatorCode } from "../../../test/authenticator.js";
import { testDatabase } from "../../../test/postgres.js";
import { testAuth } from "../../../test/stores.js";
import {
  betterAuthSecretConfig,
  hashPassword,
  SETUP_TOKEN_HEADER,
  type SwizzleAuth,
  type SwizzleAuthOptions,
} from "./auth.js";
import { causeCode, PG_ERROR } from "./client.js";
import { authAccounts, authSessions, authTotpUses, authUsers } from "./schema.js";

const ORIGIN = "http://dashboard.test";
const PERSON = { email: "ada@example.test", name: "Ada", password: "correct horse battery" };
const OTHER_PERSON = { email: "grace@example.test", password: "another long passphrase" };
const keyring = betterAuthSecretConfig(process.env);
const SECRET = keyring.keys.get(keyring.currentVersion) ?? fail();
const START = new Date("2030-01-01T00:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

// Sign-ins hash with production-cost scrypt, about 180 ms per hash on an idle core; 30 s leaves
// room for parallel worktrees on a loaded machine.
describe("Swizzle auth", () => {
  it.each([
    {
      libraryCode: "INVALID_EMAIL_OR_PASSWORD",
      path: "/sign-in/email",
      body: PERSON,
      headers: {},
      error: "AUTH_INVALID_CREDENTIALS",
      message: "The email or password is incorrect. Check both and try signing in again.",
    },
    {
      libraryCode: "INVALID_TOKEN",
      path: "/reset-password",
      body: { token: "invalid-reset-token", newPassword: PERSON.password },
      headers: {},
      error: "AUTH_RESET_LINK_INVALID",
      message: "This password reset link is invalid or expired. Request a new password reset link.",
    },
    {
      libraryCode: "INVALID_TWO_FACTOR_COOKIE",
      path: "/two-factor/verify-totp",
      body: { code: "123456" },
      headers: {},
      error: "AUTH_CODE_CHALLENGE_EXPIRED",
      message:
        "The two-factor sign-in challenge has expired. Sign in again with your email and password.",
    },
    ...[
      { libraryCode: "PASSWORD_TOO_SHORT", password: "short" },
      { libraryCode: "PASSWORD_TOO_LONG", password: "x".repeat(129) },
    ].map(({ libraryCode, password }) => ({
      libraryCode,
      path: "/sign-up/email" as const,
      body: { ...PERSON, password },
      headers: {},
      error: "AUTH_PASSWORD_INVALID",
      message:
        "The new password is outside the allowed length. Choose a password between 15 and 128 characters.",
    })),
    {
      libraryCode: "VALIDATION_ERROR (unmapped)",
      path: "/sign-in/email",
      body: {},
      headers: {},
      error: "AUTH_REQUEST_INVALID",
      message: "The authentication request failed. Check your input and try again.",
    },
  ] as const)(
    "gives a Swizzle next step for $libraryCode",
    async ({ path, body, headers, error, message }) => {
      const response = await new Browser(createAuth()).post(path, body, headers);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).toEqual({ error, message });
    },
  );

  it.each([
    { libraryCode: "INVALID_ORIGIN", origin: "https://untrusted.test" },
    { libraryCode: "MISSING_OR_NULL_ORIGIN", origin: "" },
  ])("gives a Swizzle next step for $libraryCode", async ({ origin }) => {
    // Better Auth captures NODE_ENV at import and skips origin checks under Vitest.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--conditions=swizzle-source",
        "--input-type=module",
        "-e",
        `
        import { createPostgresSwizzleAuth } from "./packages/db/src/auth.ts";
        const auth = createPostgresSwizzleAuth({
          links: null, setupToken: null, secureCookies: false, trustedOrigins: [${JSON.stringify(ORIGIN)}],
          effects: { grantProject: async () => {}, revokeTokens: async () => {} },
        });
        try {
          const { error, message, status } = await auth.handle("/sign-in/email", {
            body: ${JSON.stringify(PERSON)},
            headers: new Headers({ cookie: "swizzle.session_token=invalid", origin: ${JSON.stringify(origin)} }),
          });
          console.log(JSON.stringify({ status, body: { error, message } }));
        } finally { await auth.close(); }
      `,
      ],
      { env: { ...process.env, NODE_ENV: "production", TEST: "" } },
    );

    expect(JSON.parse(stdout)).toEqual({
      status: 403,
      body: {
        error: "AUTH_ORIGIN_FORBIDDEN",
        message: "This page is not allowed to sign in. Open the Swizzle dashboard and try again.",
      },
    });
  });

  it("fails a success answer it cannot decode with AUTH_REQUEST_FAILED", async () => {
    const browser = new Browser(await setUp());
    await browser.signIn();
    vi.spyOn(Response.prototype, "json").mockRejectedValueOnce(
      new SyntaxError("Unexpected end of JSON input"),
    );

    await expect(
      browser.post("/two-factor/enable", { password: PERSON.password }),
    ).rejects.toMatchObject({
      code: "AUTH_REQUEST_FAILED",
      message:
        "Better Auth answered /two-factor/enable in a shape Swizzle does not read. Install the Better Auth version packages/db pins, or update its reader in packages/db/src/auth.ts.",
    });
  });

  it("gives a Swizzle next step for INVALID_PASSWORD", async () => {
    const browser = new Browser(await setUp());
    await browser.signIn();
    const response = await browser.post("/change-password", {
      currentPassword: "wrong password",
      newPassword: "a new long passphrase",
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "AUTH_CURRENT_PASSWORD_INVALID",
      message: "The current password is incorrect. Enter your current password and try again.",
    });
  });

  it.each([
    { libraryCode: "INVALID_CODE", path: "/two-factor/verify-totp", code: "not-a-totp-code" },
    {
      libraryCode: "INVALID_BACKUP_CODE",
      path: "/two-factor/verify-backup-code",
      code: "not-a-recovery-code",
    },
  ] as const)("gives a Swizzle next step for $libraryCode", async ({ path, code }) => {
    const browser = new Browser(await setUp());
    await enrollTwoFactor(browser);
    const response = await browser.post(path, { code });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "AUTH_CODE_INVALID",
      message:
        "The code is incorrect, expired or already used. Enter a fresh authenticator code or an unused recovery code.",
    });
  });

  it("opens setup once, for the setup token, and then only to invitations", async () => {
    const auth = createAuth({ setupToken: "setup-secret" });
    const browser = new Browser(auth);
    expect(await auth.setupRequired()).toBe(true);
    expect(await auth.accountsWithoutTwoFactor()).toBe(0);

    const wrongToken = await browser.post("/sign-up/email", PERSON, {
      [SETUP_TOKEN_HEADER]: "guess",
    });
    const created = await browser.post("/sign-up/email", PERSON, {
      [SETUP_TOKEN_HEADER]: "setup-secret",
    });
    const second = await new Browser(auth).post(
      "/sign-up/email",
      { ...PERSON, email: "eve@example.test" },
      { [SETUP_TOKEN_HEADER]: "setup-secret" },
    );

    expect(wrongToken).toMatchObject({ body: { error: "AUTH_SETUP_TOKEN_INVALID" }, status: 403 });
    expect(created.status).toBe(200);
    expect(created.body).not.toHaveProperty("token");
    expect(second).toMatchObject({ body: { error: "AUTH_INVITATION_REQUIRED" }, status: 403 });
    expect(await auth.setupRequired()).toBe(false);
    expect(await auth.accountsWithoutTwoFactor()).toBe(1);
    expect((await browser.person())?.user).toMatchObject({ email: PERSON.email, name: "Ada" });
  });

  it("keeps the session token out of every response body", async () => {
    const auth = await setUp();
    const browser = new Browser(auth);

    const signedIn = await browser.signIn();

    expect(signedIn.status).toBe(200);
    expect(signedIn.body).not.toHaveProperty("token");
    expect(await browser.person()).not.toBeNull();
  });

  it("stores only token hashes, and a stored hash signed as a cookie does not sign in", async () => {
    const auth = await setUp();
    const browser = new Browser(auth);
    await browser.signIn();
    const token = browser.sessionToken() ?? fail();
    const stored = (await testDatabase().db.select().from(authSessions)).map((row) => row.token);

    expect(stored).toContain(createHash("sha256").update(token).digest("hex"));
    expect(stored).not.toContain(token);
    for (const digest of stored) {
      const forged = `${digest}.${createHmac("sha256", SECRET).update(String(digest)).digest("base64")}`;
      const headers = new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(forged)}` });
      expect(await auth.verifySession(headers)).toBeNull();
    }
    expect(await browser.person()).not.toBeNull();
  });

  it("lets a TOTP code open one session, also for a new challenge and under a race", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp();
    const secret = await enrollTwoFactor(new Browser(auth));
    vi.setSystemTime(START.getTime() + 30_000);
    const code = authenticatorCode(secret);

    const first = new Browser(auth);
    expect((await first.signIn()).body).toMatchObject({ twoFactorRedirect: true });
    expect((await first.post("/two-factor/verify-totp", { code })).status).toBe(200);
    expect(await first.person()).not.toBeNull();

    const second = new Browser(auth);
    await second.signIn();
    const reused = await second.post("/two-factor/verify-totp", { code });
    expect(reused).toMatchObject({ body: { error: "AUTH_CODE_INVALID" }, status: 401 });
    expect(await second.person()).toBeNull();

    vi.setSystemTime(START.getTime() + 60_000);
    const racers = [new Browser(auth), new Browser(auth), new Browser(auth)];
    for (const racer of racers) await racer.signIn();
    const nextCode = authenticatorCode(secret);
    const results = await Promise.all(
      racers.map((racer) => racer.post("/two-factor/verify-totp", { code: nextCode })),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 401, 401]);
  });

  it("accepts unused codes in the clock-skew window and refuses replay across steps", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp();
    const secret = await enrollTwoFactor(new Browser(auth));
    vi.setSystemTime(START.getTime() + 30_000);
    const aheadCode = authenticatorCode(secret, new Date(START.getTime() + 60_000));

    const ahead = new Browser(auth);
    await ahead.signIn();
    expect((await ahead.post("/two-factor/verify-totp", { code: aheadCode })).status).toBe(200);
    expect((await ahead.person())?.user.email).toBe(PERSON.email);

    const behind = new Browser(auth);
    await behind.signIn();
    const older = await behind.post("/two-factor/verify-totp", {
      code: authenticatorCode(secret),
    });
    expect(older.status).toBe(200);
    expect((await behind.person())?.user.email).toBe(PERSON.email);

    vi.setSystemTime(START.getTime() + 60_000);
    const replay = new Browser(auth);
    await replay.signIn();
    const reused = await replay.post("/two-factor/verify-totp", { code: aheadCode });
    expect(reused).toMatchObject({ body: { error: "AUTH_CODE_INVALID" }, status: 401 });
    expect(await replay.person()).toBeNull();
  });

  it("refuses a recovery code the second time", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp();
    const owner = new Browser(auth);
    const { backupCodes } = await enrollTwoFactorWithCodes(owner);
    const [recoveryCode] = backupCodes;

    const first = new Browser(auth);
    await first.signIn();
    const used = await first.post("/two-factor/verify-backup-code", { code: recoveryCode });
    const second = new Browser(auth);
    await second.signIn();
    const reused = await second.post("/two-factor/verify-backup-code", { code: recoveryCode });

    expect(used.status).toBe(200);
    expect(await first.person()).not.toBeNull();
    expect(reused.status).toBe(401);
    expect(await second.person()).toBeNull();
    const person = await owner.person();
    expect(await auth.twoFactorStatus(person?.user.id ?? "")).toEqual({
      enabled: true,
      recoveryCodesLeft: backupCodes.length - 1,
    });
  });

  it("releases refused reservations, removes expired uses and refuses expired codes", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp();
    const secret = await enrollTwoFactor(new Browser(auth));
    const futureCode = authenticatorCode(secret, new Date(START.getTime() + 90_000));
    const expiredCode = authenticatorCode(secret, new Date(START.getTime() + 30_000));
    vi.setSystemTime(START.getTime() + 30_000);
    const browser = new Browser(auth);
    await browser.signIn();
    expect((await browser.post("/two-factor/verify-totp", { code: futureCode })).status).toBe(401);

    vi.setSystemTime(START.getTime() + 60_000);
    expect((await browser.post("/two-factor/verify-totp", { code: futureCode })).status).toBe(200);
    expect((await browser.person())?.user.email).toBe(PERSON.email);
    expect(await testDatabase().db.select().from(authTotpUses)).toHaveLength(2);
    const userId = (await browser.person())?.user.id ?? fail();
    expect(
      (await testDatabase().db.select().from(authTotpUses)).map((row) => row.codeHash),
    ).toContain(createHash("sha256").update(`${userId}:${futureCode}`).digest("hex"));

    vi.setSystemTime(START.getTime() + 180_000);
    const expired = new Browser(auth);
    await expired.signIn();
    expect((await expired.post("/two-factor/verify-totp", { code: expiredCode })).status).toBe(401);
    expect(await expired.person()).toBeNull();
    expect(await testDatabase().db.select().from(authTotpUses)).toEqual([]);
  });

  it("never trusts a browser to skip the code", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp();
    const secret = await enrollTwoFactor(new Browser(auth));
    vi.setSystemTime(START.getTime() + 30_000);
    const browser = new Browser(auth);
    await browser.signIn();
    await browser.post("/two-factor/verify-totp", {
      code: authenticatorCode(secret),
      trustDevice: true,
    });
    await browser.post("/sign-out", {});

    const again = await browser.signIn();

    expect(again.body).toMatchObject({ twoFactorRedirect: true });
    expect(await browser.person()).toBeNull();
  });

  it("spends a stranger's attempts from the account budget, not a known device's", async () => {
    const auth = await setUp();
    await addSecondPerson();
    const knownDevice = new Browser(auth);
    await knownDevice.signIn();
    await knownDevice.post("/sign-out", {});
    // A device, but of another account: for Ada it is a stranger.
    const otherAccount = new Browser(auth);
    expect((await otherAccount.signIn(OTHER_PERSON.password, OTHER_PERSON.email)).status).toBe(200);

    // The known device's first sign-in came from no device yet, so it spent one of the five.
    const strangers = [new Browser(auth, "198.51.100.1"), new Browser(auth, "198.51.100.2")];
    const guesses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const stranger = strangers[attempt % 2] as Browser;
      guesses.push((await stranger.signIn("wrong password guess")).status);
    }
    const sixth = await (strangers[0] as Browser).signIn();
    const fromOtherAccountsDevice = await otherAccount.signIn();
    const fromKnownDevice = await knownDevice.signIn();

    expect(guesses).toEqual([401, 401, 401, 401]);
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fromOtherAccountsDevice.status).toBe(429);
    expect(fromKnownDevice.status).toBe(200);
  });

  it("ends a session at the idle limit", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp({ sessionIdleTimeoutMs: 30 * 60_000 });
    const active = new Browser(auth);
    const idle = new Browser(auth);
    await active.signIn();
    await idle.signIn();

    vi.setSystemTime(START.getTime() + 20 * 60_000);
    expect(await active.person()).not.toBeNull();
    vi.setSystemTime(START.getTime() + 40 * 60_000);

    expect(await active.person()).not.toBeNull();
    expect(await idle.person()).toBeNull();
  });

  it("counts use just before the touch interval toward the idle limit", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp({ sessionIdleTimeoutMs: 5 * 60_000 });
    const browser = new Browser(auth);
    await browser.signIn();

    vi.setSystemTime(START.getTime() + 4 * 60_000);
    await browser.person();
    vi.setSystemTime(START.getTime() + 8 * 60_000);
    const afterFourMinutes = await browser.person();
    vi.setSystemTime(START.getTime() + 13.5 * 60_000);

    expect(afterFourMinutes).not.toBeNull();
    expect(await browser.person()).toBeNull();
  });

  it("ends a session at the absolute limit, also after it was rotated", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp({
      sessionDurationMs: 60 * 60_000,
      sessionIdleTimeoutMs: 30 * 60_000,
    });
    const browser = new Browser(auth);
    await browser.signIn();
    const before = browser.sessionCookie();

    vi.setSystemTime(START.getTime() + 20 * 60_000);
    // Turning on 2FA replaces the session; the replacement keeps the first sign-in's end.
    await enrollTwoFactor(browser);
    expect(browser.sessionCookie()).not.toBe(before);
    vi.setSystemTime(START.getTime() + 40 * 60_000);
    expect(await browser.person()).not.toBeNull();
    vi.setSystemTime(START.getTime() + 61 * 60_000);

    expect(await browser.person()).toBeNull();
  });

  it("lists and revokes one session by id, only for its own person", async () => {
    const auth = await setUp();
    await addSecondPerson();
    const laptop = new Browser(auth);
    const phone = new Browser(auth);
    await laptop.signIn();
    const phoneAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0";
    await phone.post(
      "/sign-in/email",
      { email: PERSON.email, password: PERSON.password },
      { "user-agent": phoneAgent },
    );
    const stranger = new Browser(auth);
    await stranger.signIn(OTHER_PERSON.password, OTHER_PERSON.email);
    const person = (await laptop.person()) ?? fail();
    const phoneSessionId = (await phone.person())?.sessionId ?? fail();
    const strangerPerson = (await stranger.person()) ?? fail();

    const sessions = await auth.listSessions(person);
    const foreignRevoke = await auth.revokeSession(strangerPerson.user.id, phoneSessionId);
    const revoked = await auth.revokeSession(person.user.id, phoneSessionId);

    // Setup signed in a third browser.
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((session) => session.current).map((session) => session.id)).toEqual([
      person.sessionId,
    ]);
    // Each session keeps the browser it signed in from, so the person can tell them apart.
    expect(sessions.find((session) => session.id === phoneSessionId)?.userAgent).toBe(phoneAgent);
    expect(foreignRevoke).toBe(false);
    expect(revoked).toBe(true);
    expect(await phone.person()).toBeNull();
    expect(await laptop.person()).not.toBeNull();
  });

  it("asks for a code to change the password while 2FA is on, then signs out every other browser", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp();
    const laptop = new Browser(auth);
    const secret = await enrollTwoFactor(laptop);
    vi.setSystemTime(START.getTime() + 30_000);
    const phone = new Browser(auth);
    await phone.signIn();
    await phone.post("/two-factor/verify-totp", { code: authenticatorCode(secret) });
    vi.setSystemTime(START.getTime() + 60_000);
    const change = { currentPassword: PERSON.password, newPassword: "a brand new passphrase" };

    const withoutCode = await laptop.post("/change-password", change);
    const changed = await laptop.post("/change-password", {
      ...change,
      code: authenticatorCode(secret),
    });

    expect(withoutCode).toMatchObject({ body: { error: "AUTH_CODE_REQUIRED" }, status: 401 });
    expect(changed.status).toBe(200);
    expect(changed.body).not.toHaveProperty("token");
    expect(await laptop.person()).not.toBeNull();
    expect(await phone.person()).toBeNull();
    expect((await new Browser(auth).signIn()).status).toBe(401);
  });

  it("signs every other browser out when 2FA turns on or off, not when a code signs in", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp();
    const laptop = new Browser(auth);
    const phone = new Browser(auth);
    await phone.signIn();

    const secret = await enrollTwoFactor(laptop);
    const phoneAfterOn = await phone.person();
    vi.setSystemTime(START.getTime() + 30_000);
    const tablet = new Browser(auth);
    await tablet.signIn();
    await tablet.post("/two-factor/verify-totp", { code: authenticatorCode(secret) });
    const laptopAfterSignIn = await laptop.person();
    vi.setSystemTime(START.getTime() + 60_000);
    const disabled = await laptop.post("/two-factor/disable", {
      code: authenticatorCode(secret),
      password: PERSON.password,
    });

    expect(phoneAfterOn).toBeNull();
    expect(laptopAfterSignIn).not.toBeNull();
    expect(disabled.status).toBe(200);
    expect(await tablet.person()).toBeNull();
    expect(await laptop.person()).not.toBeNull();
  });

  it("keeps a recovery code when the password change or turn-off it came with is refused", async () => {
    const auth = await setUp();
    const browser = new Browser(auth);
    const {
      backupCodes: [code],
    } = await enrollTwoFactorWithCodes(browser);
    const newPassword = "a brand new passphrase";

    const tooShort = await browser.post("/change-password", {
      code,
      currentPassword: PERSON.password,
      newPassword: "short",
    });
    const wrongCurrent = await browser.post("/change-password", {
      code,
      currentPassword: "not the password at all",
      newPassword,
    });
    const wrongForOff = await browser.post("/two-factor/disable", {
      code,
      password: "not the password at all",
    });
    const changed = await browser.post("/change-password", {
      code,
      currentPassword: PERSON.password,
      newPassword,
    });

    expect(tooShort).toMatchObject({ body: { error: "AUTH_PASSWORD_INVALID" }, status: 400 });
    expect(wrongCurrent).toMatchObject({
      body: { error: "AUTH_CURRENT_PASSWORD_INVALID" },
      status: 400,
    });
    expect(wrongForOff).toMatchObject({
      body: { error: "AUTH_CURRENT_PASSWORD_INVALID" },
      status: 400,
    });
    expect(changed.status).toBe(200);
    expect(await auth.twoFactorStatus((await browser.person())?.user.id ?? fail())).toEqual({
      enabled: true,
      recoveryCodesLeft: 9,
    });
  });

  it("asks for a code to turn 2FA off", async () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    const auth = await setUp();
    const browser = new Browser(auth);
    const secret = await enrollTwoFactor(browser);
    vi.setSystemTime(START.getTime() + 30_000);

    const withoutCode = await browser.post("/two-factor/disable", { password: PERSON.password });
    const disabled = await browser.post("/two-factor/disable", {
      code: authenticatorCode(secret),
      password: PERSON.password,
    });

    expect(withoutCode).toMatchObject({ body: { error: "AUTH_CODE_REQUIRED" }, status: 401 });
    expect(disabled.status).toBe(200);
    expect((await browser.person())?.user.twoFactorEnabled).toBe(false);
  });

  it("lists every person, past the adapter's 100-row default", async () => {
    const auth = await setUp();
    const now = new Date();
    for (let index = 0; index < 150; index += 1) {
      await testDatabase()
        .db.insert(authUsers)
        .values({
          createdAt: now,
          email: `person-${String(index).padStart(3, "0")}@example.test`,
          emailVerified: false,
          id: randomUUID(),
          name: `Person ${index}`,
          role: "member",
          twoFactorEnabled: false,
          updatedAt: now,
        });
    }
    const people = await auth.listPeople();
    expect(people).toHaveLength(151);
    expect(people.at(-1)?.email).toBe("person-149@example.test");
  });

  it("refuses text that is not a UUID in a uuid column, with PostgreSQL's error code", async () => {
    const auth = await setUp();
    await expect(auth.findPerson(randomUUID())).resolves.toBeNull();
    const refused = await auth.findPerson("nobody@example.test").catch((error: unknown) => error);
    expect(causeCode(refused)).toBe(PG_ERROR.invalidTextRepresentation);
  });
});

type TestOptions = Partial<SwizzleAuthOptions>;

function createAuth(options: TestOptions = {}): SwizzleAuth {
  return testAuth({ trustedOrigins: [ORIGIN], ...options });
}

async function setUp(options: TestOptions = {}): Promise<SwizzleAuth> {
  const auth = createAuth(options);
  const created = await new Browser(auth).post("/sign-up/email", PERSON);
  expect(created.status).toBe(200);
  return auth;
}

/** A second account, written as rows, for tests about something other than invitations. */
async function addSecondPerson(): Promise<void> {
  const id = randomUUID();
  const now = new Date();
  await testDatabase().db.insert(authUsers).values({
    createdAt: now,
    email: OTHER_PERSON.email,
    emailVerified: false,
    id,
    name: "Grace",
    role: "member",
    twoFactorEnabled: false,
    updatedAt: now,
  });
  await testDatabase()
    .db.insert(authAccounts)
    .values({
      accountId: id,
      createdAt: now,
      id: randomUUID(),
      password: await hashPassword(OTHER_PERSON.password),
      providerId: "credential",
      updatedAt: now,
      userId: id,
    });
}

async function enrollTwoFactorWithCodes(
  browser: Browser,
): Promise<{ backupCodes: string[]; secret: string }> {
  if ((await browser.person()) === null) await browser.signIn();
  const enabled = await browser.post("/two-factor/enable", { password: PERSON.password });
  const { backupCodes, totpURI } = enabled.body as { backupCodes: string[]; totpURI: string };
  const secret = new URL(totpURI).searchParams.get("secret") ?? fail();
  const verified = await browser.post("/two-factor/verify-totp", {
    code: authenticatorCode(secret),
  });
  expect(verified.status).toBe(200);
  return { backupCodes, secret };
}

async function enrollTwoFactor(browser: Browser): Promise<string> {
  return (await enrollTwoFactorWithCodes(browser)).secret;
}

function fail(): never {
  throw new Error("expected a value");
}

class Browser extends AuthBrowser {
  constructor(auth: SwizzleAuth, address?: string) {
    super(auth, ORIGIN, address);
  }

  async signIn(password = PERSON.password, email = PERSON.email) {
    return await this.post("/sign-in/email", { email, password });
  }
}
