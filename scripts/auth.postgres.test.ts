import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { RELEASE_TEAM_ID } from "@swizzle/db";
import {
  betterAuthSecretConfig,
  causeCode,
  createPostgresSwizzleAuth,
  type DatabaseClient,
  INVITATION_TOKEN_HEADER,
  PG_ERROR,
  reencryptStoredCredentials,
  type SwizzleAuth,
} from "@swizzle/db/postgres";
import { it } from "vitest";
import { AuthBrowser, SESSION_COOKIE } from "../test/auth-browser.js";
import { authenticatorCode, wrongAuthenticatorCode } from "../test/authenticator.js";
import { testDatabase, untilLockWaiters } from "../test/postgres.js";

const ORIGIN = "http://dashboard.verify";
const PERSON = { email: "ada@example.com", name: "Ada", password: "correct horse battery staple" };
const SETUP_TOKEN = "verify-setup-token-with-at-least-32-bytes";

async function verifyAuth(client: DatabaseClient): Promise<void> {
  const mails: string[] = [];
  const start = () =>
    createPostgresSwizzleAuth({
      client,
      effects: { grantProject: async () => undefined, revokeTokens: async () => undefined },
      links: {
        origin: ORIGIN,
        mailer: { send: async (mail) => void mails.push(mail.text) },
      },
      secureCookies: false,
      setupToken: SETUP_TOKEN,
      trustedOrigins: [ORIGIN],
    });
  const auth = start();
  const browser = (address?: string) => new AuthBrowser(auth, ORIGIN, address);

  await verifySetupOnce(client, browser);
  assert.equal(await auth.setupRequired(), true);
  assert.equal(await auth.accountsWithoutTwoFactor(), 0);
  const owner = browser();
  const created = await owner.post("/sign-up/email", PERSON, {
    "x-swizzle-setup-token": SETUP_TOKEN,
  });
  assert.equal(created.status, 200);
  assert.equal(await auth.setupRequired(), false);
  assert.equal(await auth.accountsWithoutTwoFactor(), 1);
  const { rows } = await client.pool.query<{ role: string }>(
    "SELECT role FROM auth_users WHERE email = $1",
    [PERSON.email],
  );
  assert.deepEqual(rows, [{ role: "owner" }], "the first account is the instance owner");

  await assert.rejects(
    auth.findPerson("nobody@example.com"),
    (error) => causeCode(error) === PG_ERROR.invalidTextRepresentation,
    "a uuid column refuses text that is not a UUID",
  );
  await verifyHashesAtRest(client, auth, owner);
  // Each race below signs in from new browsers, which share the account's budgets; every section
  // starts from full budgets, so one section's attempts do not decide the next one's.
  const { recoveryCodes, secret } = await verifySingleUseCodes(client, owner, browser);
  assert.equal(await auth.accountsWithoutTwoFactor(), 0);
  await client.pool.query("DELETE FROM auth_budgets");
  const signedIn = await verifyRecoveryCode(browser, recoveryCodes);
  await verifySessionLimits(client, auth, owner);
  await client.pool.query("DELETE FROM auth_budgets");
  await verifyBudgetsOutliveTheServer(start, browser);
  await client.pool.query("DELETE FROM auth_budgets");
  await verifyKeyRotation(client, start, signedIn, { recoveryCodes, secret });
  await client.pool.query("DELETE FROM auth_budgets");
  const owners = await verifyInvitationOnce(client, auth, browser, mails);
  await verifySuspension(client, auth, browser, owners[0]);
  const admin = await verifyLastOwnerRace(client, auth, owners);
  await verifyPromotionWhileWaiting(client, auth, browser, mails, admin);
  await auth.close();
  process.stdout.write(
    "Postgres auth: setup existence and filtered two-factor count, setup once under a race, its winner in the team Release, hashed sessions, budgets across restarts, single-use codes, session limits, recovery codes, key rotation, an invitation accepted once under a race, suspension, the last owner under a race and an admin's change after a promotion passed.\n",
  );
}

/**
 * Two setups with different emails both pass the "no account yet" check while each hashes its
 * password; the claim in the user insert's transaction lets one create an account. The accounts
 * and budgets are removed afterwards, so the rest starts from a fresh instance.
 */
async function verifySetupOnce(
  client: DatabaseClient,
  browser: (address?: string) => AuthBrowser,
): Promise<void> {
  const racers = [PERSON, { ...PERSON, email: "grace@example.com", name: "Grace" }];
  const statuses = await Promise.all(
    racers.map(
      async (person, index) =>
        (
          await browser(`192.0.2.${30 + index}`).post("/sign-up/email", person, {
            "x-swizzle-setup-token": SETUP_TOKEN,
          })
        ).status,
    ),
  );
  assert.deepEqual(statuses.sort(), [200, 409]);
  const { rows } = await client.pool.query<{ count: string }>("SELECT count(*) FROM auth_users");
  assert.equal(rows[0]?.count, "1");
  // The account that won is the first owner and the team Release's only member.
  const winner = await client.pool.query<{ id: string }>("SELECT id FROM auth_users");
  const release = await client.pool.query<{ id: string }>(
    "SELECT user_id AS id FROM team_members WHERE team_id = $1",
    [RELEASE_TEAM_ID],
  );
  assert.deepEqual(release.rows, winner.rows);
  await client.pool.query("DELETE FROM auth_users");
  await client.pool.query("DELETE FROM auth_budgets");
}

/** A2: the row holds H(token), and the row's value signed as a cookie opens nothing. */
async function verifyHashesAtRest(
  client: DatabaseClient,
  auth: SwizzleAuth,
  owner: AuthBrowser,
): Promise<void> {
  const token = owner.sessionToken();
  assert.ok(token);
  const { rows } = await client.pool.query<{ token: string }>("SELECT token FROM auth_sessions");
  assert.deepEqual(
    rows.map((row) => row.token),
    [createHash("sha256").update(token).digest("hex")],
  );
  const { currentVersion, keys } = betterAuthSecretConfig(process.env);
  const secret = keys.get(currentVersion) ?? "";
  for (const { token: digest } of rows) {
    const signature = createHmac("sha256", secret).update(digest).digest("base64");
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(`${digest}.${signature}`)}`;
    assert.equal(await auth.verifySession(new Headers({ cookie })), null);
  }
  assert.ok(await owner.person());
}

/** A4: a new auth instance on the same database spends the budget the old one left. */
async function verifyBudgetsOutliveTheServer(
  start: () => SwizzleAuth,
  browser: (address?: string) => AuthBrowser,
): Promise<void> {
  const guess = { email: PERSON.email, password: "wrong password guess" };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await browser("198.51.100.1").post("/sign-in/email", guess)).status, 401);
  }
  const restarted = start();
  const limited = await new AuthBrowser(restarted, ORIGIN, "198.51.100.2").post(
    "/sign-in/email",
    guess,
  );
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  await restarted.close();
}

/**
 * A3: of three challenges racing one code, one opens a session; a later challenge with the same
 * code opens none. Returns the recovery codes and the TOTP secret.
 */
async function verifySingleUseCodes(
  client: DatabaseClient,
  owner: AuthBrowser,
  browser: (address?: string) => AuthBrowser,
): Promise<{ recoveryCodes: readonly string[]; secret: string }> {
  const enabled = await owner.post("/two-factor/enable", { password: PERSON.password });
  assert.equal(enabled.status, 200);
  const secret = new URL(String(enabled.body?.totpURI)).searchParams.get("secret") ?? "";
  const before = await sessionEnd(client);
  assert.equal(
    (await owner.post("/two-factor/verify-totp", { code: authenticatorCode(secret) })).status,
    200,
  );
  // Turning 2FA on replaced the session; the replacement keeps the first sign-in's end.
  assert.equal((await sessionEnd(client)).getTime(), before.getTime());

  const nextCode = authenticatorCode(secret, new Date(Date.now() + 30_000));
  const racers = [browser("192.0.2.1"), browser("192.0.2.2"), browser("192.0.2.3")];
  for (const racer of racers) {
    const challenged = await racer.post("/sign-in/email", PERSON);
    assert.equal(challenged.body?.twoFactorRedirect, true);
  }
  const statuses = await Promise.all(
    racers.map(
      async (racer) => (await racer.post("/two-factor/verify-totp", { code: nextCode })).status,
    ),
  );
  assert.deepEqual(statuses.sort(), [200, 401, 401]);

  const late = browser("192.0.2.4");
  await late.post("/sign-in/email", PERSON);
  const reused = await late.post("/two-factor/verify-totp", { code: nextCode });
  assert.equal(reused.status, 401);
  assert.equal(reused.body?.error, "AUTH_CODE_INVALID");
  assert.equal(await late.person(), null);
  return { recoveryCodes: enabled.body?.backupCodes as string[], secret };
}

/** A4: the persisted row ends a session at its idle and its absolute limit. */
async function verifySessionLimits(
  client: DatabaseClient,
  auth: SwizzleAuth,
  owner: AuthBrowser,
): Promise<void> {
  const person = await owner.person();
  assert.ok(person);
  const where = [person.sessionId];
  await client.pool.query(
    "UPDATE auth_sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = $1",
    where,
  );
  assert.equal(await owner.person(), null);
  await client.pool.query("UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1", where);
  assert.ok(await owner.person());
  await client.pool.query(
    "UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE id = $1",
    where,
  );
  assert.equal(await owner.person(), null);
  assert.equal(
    (await auth.listSessions(person)).some((session) => session.id === person.sessionId),
    false,
  );
}

/**
 * Of two challenges racing one recovery code, one opens a session. Better Auth answers the loser
 * of its compare-and-swap with 409 and a later attempt with 401; either opens nothing. Returns the
 * browser that signed in.
 */
async function verifyRecoveryCode(
  browser: (address?: string) => AuthBrowser,
  recoveryCodes: readonly string[],
): Promise<AuthBrowser> {
  const [code] = recoveryCodes;
  assert.ok(code);
  const racers = [browser("192.0.2.5"), browser("192.0.2.6")];
  for (const racer of racers) await racer.post("/sign-in/email", PERSON);
  await Promise.all(racers.map((racer) => racer.post("/two-factor/verify-backup-code", { code })));
  const signedIn = await Promise.all(racers.map(async (racer) => (await racer.person()) !== null));
  assert.deepEqual([...signedIn].sort(), [false, true]);
  return racers[signedIn.indexOf(true)] as AuthBrowser;
}

/**
 * After `just db-reencrypt` and dropping the old key, the TOTP secret and the recovery codes still
 * open, and a cookie signed under the old key opens nothing.
 */
async function verifyKeyRotation(
  client: DatabaseClient,
  start: () => SwizzleAuth,
  signedIn: AuthBrowser,
  factor: { recoveryCodes: readonly string[]; secret: string },
): Promise<void> {
  const environment = {
    current: process.env.SWIZZLE_ENCRYPTION_KEY,
    previous: process.env.SWIZZLE_ENCRYPTION_PREVIOUS_KEYS,
  };
  try {
    process.env.SWIZZLE_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify([environment.current]);
    process.env.SWIZZLE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    assert.equal((await reencryptStoredCredentials(client.db)).twoFactorSecrets, 1);
    process.env.SWIZZLE_ENCRYPTION_PREVIOUS_KEYS = "[]";
    const rotated = start();
    assert.equal(await new AuthBrowser(rotated, ORIGIN).person(), null);
    assert.equal(
      await rotated.verifySession(
        new Headers({ cookie: `${SESSION_COOKIE}=${signedIn.sessionCookie()}` }),
      ),
      null,
    );
    const browser = new AuthBrowser(rotated, ORIGIN, "192.0.2.20");
    await browser.post("/sign-in/email", PERSON);
    // A secret that no longer decrypts answers 500; a wrong code for a readable one answers 401.
    assert.equal(
      (
        await browser.post("/two-factor/verify-totp", {
          code: wrongAuthenticatorCode(factor.secret),
        })
      ).status,
      401,
    );
    const recovered = await browser.post("/two-factor/verify-backup-code", {
      code: factor.recoveryCodes[1],
    });
    assert.equal(recovered.status, 200);
    assert.ok(await browser.person());
    await rotated.close();
  } finally {
    // Assigning undefined to process.env stores the text "undefined", which later steps read.
    for (const [name, value] of [
      ["SWIZZLE_ENCRYPTION_KEY", environment.current],
      ["SWIZZLE_ENCRYPTION_PREVIOUS_KEYS", environment.previous],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const ANNA = { email: "anna@example.com", name: "Anna", password: "anna's long passphrase" };

/**
 * Two browsers race one owner invitation for the same address; one account comes of it. Returns
 * both owners' ids, Ada's first.
 */
async function verifyInvitationOnce(
  client: DatabaseClient,
  auth: SwizzleAuth,
  browser: (address?: string) => AuthBrowser,
  mails: readonly string[],
): Promise<readonly [string, string]> {
  const { rows } = await client.pool.query<{ id: string }>(
    "SELECT id FROM auth_users WHERE email = $1",
    [PERSON.email],
  );
  const adaId = rows[0]?.id ?? "";
  await auth.invite({ email: ANNA.email, grants: [], invitedBy: adaId, role: "owner" });
  const token = new RegExp(`${ORIGIN}/invitation#(\\S+)`, "u").exec(mails.at(-1) ?? "")?.[1];
  assert.ok(token, "the invitation mail carries its link");
  const racers = [browser("192.0.2.40"), browser("192.0.2.41")];
  const statuses = await Promise.all(
    racers.map(
      async (racer) =>
        (await racer.post("/sign-up/email", ANNA, { [INVITATION_TOKEN_HEADER]: token })).status,
    ),
  );
  assert.equal(statuses.filter((status) => status === 200).length, 1, `statuses ${statuses}`);
  const accounts = await client.pool.query<{ id: string; role: string }>(
    "SELECT id, role FROM auth_users WHERE email = $1",
    [ANNA.email],
  );
  assert.equal(accounts.rows.length, 1);
  assert.equal(accounts.rows[0]?.role, "owner");
  return [adaId, accounts.rows[0]?.id ?? ""];
}

/** Suspension writes suspended_at, deletes the person's session rows and refuses the password. */
async function verifySuspension(
  client: DatabaseClient,
  auth: SwizzleAuth,
  browser: (address?: string) => AuthBrowser,
  ownerId: string,
): Promise<void> {
  const anna = browser("192.0.2.42");
  await anna.post("/sign-in/email", ANNA);
  const person = await anna.person();
  assert.ok(person);
  await auth.setSuspended(ownerId, person.user.id, true);
  const sessions = await client.pool.query("SELECT 1 FROM auth_sessions WHERE user_id = $1", [
    person.user.id,
  ]);
  assert.equal(sessions.rows.length, 0);
  assert.equal(await anna.person(), null);
  const refused = await browser("192.0.2.43").post("/sign-in/email", ANNA);
  assert.equal(refused.body?.error, "AUTH_ACCOUNT_SUSPENDED");
  await auth.setSuspended(ownerId, person.user.id, false);
}

/** Two owners step down at once; one stays an owner. Returns the one who became an admin. */
async function verifyLastOwnerRace(
  client: DatabaseClient,
  auth: SwizzleAuth,
  owners: readonly [string, string],
): Promise<string> {
  const results = await Promise.allSettled(owners.map((id) => auth.setRole(id, id, "admin")));
  const refused = results.filter((result) => result.status === "rejected");
  assert.equal(refused.length, 1, "exactly one demotion is refused");
  assert.equal((refused[0] as PromiseRejectedResult).reason.code, "AUTH_LAST_OWNER");
  const { rows } = await client.pool.query("SELECT 1 FROM auth_users WHERE role = 'owner'");
  assert.equal(rows.length, 1);
  return results[0]?.status === "fulfilled" ? owners[0] : owners[1];
}

/**
 * An admin suspends a member while an owner's transaction, holding the account-management lock, promotes that
 * member. The admin's change waits on that lock, then reads the person as an owner and is
 * refused; the member's promotion stands and they are not suspended.
 */
async function verifyPromotionWhileWaiting(
  client: DatabaseClient,
  auth: SwizzleAuth,
  browser: (address?: string) => AuthBrowser,
  mails: readonly string[],
  adminId: string,
): Promise<void> {
  const { rows } = await client.pool.query<{ id: string }>(
    "SELECT id FROM auth_users WHERE role = 'owner'",
  );
  const ownerId = rows[0]?.id ?? "";
  const carl = { email: "carl@example.com", name: "Carl", password: "carl's long passphrase" };
  await auth.invite({ email: carl.email, grants: [], invitedBy: ownerId, role: "member" });
  const token = new RegExp(`${ORIGIN}/invitation#(\\S+)`, "u").exec(mails.at(-1) ?? "")?.[1];
  const joined = await browser("192.0.2.44").post("/sign-up/email", carl, {
    [INVITATION_TOKEN_HEADER]: token ?? "",
  });
  assert.equal(joined.status, 200);
  const carlId = (
    await client.pool.query<{ id: string }>("SELECT id FROM auth_users WHERE email = $1", [
      carl.email,
    ])
  ).rows[0]?.id;
  assert.ok(carlId);

  const promotion = await client.pool.connect();
  try {
    await promotion.query("BEGIN");
    await promotion.query("SELECT pg_advisory_xact_lock(193720, 1)");
    await promotion.query("UPDATE auth_users SET role = 'owner' WHERE id = $1", [carlId]);
    const suspension = auth.setSuspended(adminId, carlId, true).then(
      () => "suspended",
      (error: { code?: string }) => error.code,
    );
    await untilLockWaiters(client, 1);
    await promotion.query("COMMIT");
    assert.equal(await suspension, "ACCESS_DENIED");
  } finally {
    promotion.release();
  }
  const after = await client.pool.query<{ role: string; suspended_at: Date | null }>(
    "SELECT role, suspended_at FROM auth_users WHERE id = $1",
    [carlId],
  );
  assert.deepEqual(after.rows, [{ role: "owner", suspended_at: null }]);
}

async function sessionEnd(client: DatabaseClient): Promise<Date> {
  const { rows } = await client.pool.query<{ expires_at: Date }>(
    "SELECT expires_at FROM auth_sessions ORDER BY created_at DESC LIMIT 1",
  );
  assert.ok(rows[0]);
  return rows[0].expires_at;
}

it("auth", async () => {
  const client = testDatabase();
  await verifyAuth(client);
});
