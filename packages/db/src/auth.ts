/**
 * Sign-in for people: Better Auth with the guarantees Swizzle adds (ADR 0014). The API forwards
 * the routes in AuthResults to `handle` and asks `verifySession` who sent a request. Everything
 * else Better Auth offers stays unreachable over HTTP. `handle` turns success answers into the
 * records in auth-types.ts. Actions whose result is carried by cookies or account state answer
 * only a Swizzle acknowledgment.
 *
 * - auth-session-store.ts keeps only token hashes and owns the idle and absolute session limits.
 * - auth-guarantees.ts spends the device and account budgets and requires codes for sensitive writes.
 * - auth-two-factor.ts delegates code checks to Better Auth and prevents TOTP replay.
 *
 * The Postgres variant derives Better Auth's secrets from SWIZZLE_ENCRYPTION_KEY and its previous
 * keys, so the TOTP secrets and recovery codes it encrypts follow key rotation.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { PASSWORD_LENGTH } from "@swizzle/config";
import { API_ERROR_STATUS, type ApiErrorCode, createLogger, isApiErrorCode } from "@swizzle/core";
import type { BetterAuthOptions, DBAdapterInstance } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import type { InstanceRole } from "./access.js";
import { CLIENT_ADDRESS_HEADER, swizzleGuarantees } from "./auth-guarantees.js";
import {
  type AccountEffects,
  type AccountLinks,
  createPeople,
  type Invitation,
  type OwnerRecovery,
  type PendingGrant,
  passwordResetMail,
  type ResetLink,
  type SentInvitation,
  swizzleMembership,
} from "./auth-membership.js";
import { withHashedSessions } from "./auth-session-store.js";
import { createAuthFactors } from "./auth-two-factor.js";
import type {
  AuthActionResult,
  AuthSessionMetadata,
  AuthUser,
  SignInResult,
  TwoFactorEnrollment,
  TwoFactorStatus,
} from "./auth-types.js";
import { type SpendBudget, spendBudget } from "./budgets.js";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { CodedError } from "./coded-error.js";
import { createPostgresPeopleStore, type PeopleStore, type UserRow } from "./people-store.js";
import {
  authAccounts,
  authBudgets,
  authDevices,
  authSessions,
  authTotpUses,
  authTwoFactors,
  authUsers,
  authVerifications,
  invitations,
  teamMembers,
} from "./schema.js";
import { resolveSecretEncryptionKeyring } from "./secrets.js";

export { CLIENT_ADDRESS_HEADER } from "./auth-guarantees.js";
export {
  type AccountEffects,
  type AccountLinks,
  accountEffects,
  INVITATION_TOKEN_HEADER,
  type Invitation,
  type OwnerRecovery,
  type PendingGrant,
  type ResetLink,
  SETUP_TOKEN_HEADER,
  type SentInvitation,
} from "./auth-membership.js";

/**
 * What each Better Auth route the API forwards answers on success, as `handle` parses it.
 */
export interface AuthResults {
  "/sign-up/email": AuthActionResult;
  "/sign-in/email": SignInResult;
  "/sign-out": AuthActionResult;
  "/change-password": AuthActionResult;
  "/two-factor/enable": TwoFactorEnrollment;
  "/two-factor/verify-totp": AuthActionResult;
  "/two-factor/verify-backup-code": AuthActionResult;
  "/two-factor/disable": AuthActionResult;
  "/request-password-reset": AuthActionResult;
  "/reset-password": AuthActionResult;
}
export type AuthRoute = keyof AuthResults;

/**
 * A forwarded route's answer. `headers` carries what the browser needs, such as cookies and
 * Retry-After; a failure carries Swizzle's code and recovery step in place of the library's.
 */
export type AuthAnswer<Route extends AuthRoute> = {
  readonly headers: Headers;
  readonly status: number;
} & (
  | { readonly ok: true; readonly result: AuthResults[Route] }
  | { readonly ok: false; readonly error: ApiErrorCode; readonly message: string }
);

const AUTH_BASE_PATH = "/auth";
/** The origin of the requests `handle` makes; `.invalid` never resolves, so no page has it. */
const AUTH_BASE_URL = "http://swizzle.invalid";

/** A live session: not expired, not idle, not signed out. */
export interface SignedInPerson {
  readonly sessionId: string;
  readonly user: AuthUser;
}

export interface SwizzleAuth {
  /**
   * Runs one forwarded route with the browser's JSON body and the request headers Better Auth
   * reads. AUTH_REQUEST_FAILED when successful JSON cannot be decoded or a required sign-in
   * or enrollment field cannot be read.
   */
  handle<Route extends AuthRoute>(
    route: Route,
    request: { readonly body: unknown; readonly headers: Headers },
  ): Promise<AuthAnswer<Route>>;
  /** Null for no session cookie, a forged one, or an expired, idle or ended session. */
  verifySession(headers: Headers): Promise<SignedInPerson | null>;
  /** True until the first account exists; setup then closes for good. */
  setupRequired(): Promise<boolean>;
  /** Whether setup asks for SWIZZLE_SETUP_TOKEN in SETUP_TOKEN_HEADER. */
  readonly setupTokenRequired: boolean;
  /** How many accounts sign in with a password alone. */
  accountsWithoutTwoFactor(): Promise<number>;
  /** The person a personal API token acts as; null once the account is gone. */
  findPerson(userId: string): Promise<AuthUser | null>;
  listPeople(): Promise<readonly AuthUser[]>;
  listSessions(person: SignedInPerson): Promise<readonly AuthSessionMetadata[]>;
  /** False when the id names no live session of this user. */
  revokeSession(userId: string, sessionId: string): Promise<boolean>;
  revokeAllSessions(userId: string): Promise<void>;
  twoFactorStatus(userId: string): Promise<TwoFactorStatus>;
  /** Whether invitations and password resets go out by mail (SwizzleAuthOptions.links). */
  readonly mailConfigured: boolean;
  /**
   * Invites `email` to join as `role`, with the project grants it promises, and returns the link
   * for the inviter to pass on; with mail configured the link also goes out by mail. A pending
   * invitation to the same address is replaced. ACCESS_DENIED when `invitedBy` may not give that
   * role (mayManagePeople) or is suspended; AUTH_ACCOUNT_EXISTS when the address has an account;
   * AUTH_MAIL_FAILED, with nothing stored, when the mail server refused.
   */
  invite(input: {
    readonly email: string;
    readonly role: InstanceRole;
    readonly grants: readonly PendingGrant[];
    readonly invitedBy: string;
  }): Promise<SentInvitation>;
  /** The pending invitation the token opens; null when unknown, used, revoked or expired. */
  findInvitation(token: string): Promise<Invitation | null>;
  /** Pending invitations, newest first. */
  listInvitations(): Promise<readonly Invitation[]>;
  /** False when no pending invitation has this id; ACCESS_DENIED as for setRole. */
  revokeInvitation(actorId: string, invitationId: string): Promise<boolean>;
  /**
   * Null when no account has this id. ACCESS_DENIED when the actor, as stored when the change
   * runs, may not change this person or give this role (mayManagePeople); AUTH_LAST_OWNER when it
   * would leave no active owner.
   */
  setRole(actorId: string, userId: string, role: InstanceRole): Promise<AuthUser | null>;
  /** Suspending signs the person out at once; errors as for setRole. */
  setSuspended(actorId: string, userId: string, suspended: boolean): Promise<AuthUser | null>;
  /**
   * Offboarding: deletes the account with its sessions, factors, API tokens, team memberships and
   * grants. False when no account has this id; errors as for setRole.
   */
  removePerson(actorId: string, userId: string): Promise<boolean>;
  /**
   * For a person who lost both the authenticator and the recovery codes: turns their two-factor
   * sign-in off and signs them out everywhere. False when they had none; ACCESS_DENIED as for
   * setRole.
   */
  resetTwoFactor(actorId: string, userId: string): Promise<boolean>;
  /**
   * For a person who forgot the password, with or without mail: a reset link for the actor to
   * hand over, shown once. Null when no account has this id; ACCESS_DENIED as for setRole, and
   * for the actor's own account, whose password changes under Settings › Account.
   */
  createResetLink(actorId: string, userId: string): Promise<ResetLink | null>;
  close(): Promise<void>;
}

/**
 * What only a shell on the host may do, through apps/api/src/recover-owner.ts. The API server
 * builds SwizzleAuth alone, so no request reaches this.
 */
export interface HostAuth {
  /**
   * For an owner locked out of the dashboard, who lost the password while mail is off, or the
   * authenticator and the recovery codes: turns their two-factor sign-in off, signs them out
   * everywhere and mints a reset link that sets a new password once, within the hour. Using it
   * revokes their agent tokens, as a mailed one does. Changes nothing when `email` names no
   * active owner.
   */
  recoverOwner(email: string): Promise<OwnerRecovery>;
  close(): Promise<void>;
}

export interface SwizzleAuthOptions {
  /** SWIZZLE_SETUP_TOKEN: the first account must present it. Null leaves setup open. */
  readonly setupToken: string | null;
  /** Whether cookies carry `Secure` and the `__Secure-` prefix. */
  readonly secureCookies: boolean;
  /** Pages allowed to send credentialed writes, from SWIZZLE_CORS_ORIGINS. */
  readonly trustedOrigins: readonly string[];
  readonly sessionDurationMs?: number;
  readonly sessionIdleTimeoutMs?: number;
  /** What the access and token stores do when an account changes. */
  readonly effects: AccountEffects;
  /** Dashboard links, with an optional mailer. Null disables invitations and reset links. */
  readonly links: AccountLinks | null;
}

const DEFAULT_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function createPostgresSwizzleAuth(
  options: SwizzleAuthOptions & {
    readonly client?: DatabaseClient;
    readonly connectionString?: string;
  },
): SwizzleAuth {
  const client =
    options.client ??
    createDatabaseClient(
      options.connectionString !== undefined ? { connectionString: options.connectionString } : {},
    );
  const database = drizzleAdapter(client.db, {
    provider: "pg",
    // Sign-up claims setup inside the transaction that inserts the user (auth-membership.ts).
    transaction: true,
    schema: AUTH_SCHEMA,
  });
  return buildAuth(
    database,
    betterAuthSecrets(process.env),
    options,
    createPostgresPeopleStore(client.db),
    (key, limit, windowMs) => spendBudget(client.db, key, limit, windowMs),
    async () => {
      if (options.client === undefined) await client.close();
    },
  );
}

/**
 * The tables by Better Auth model name. Swizzle's additional models are declared by the
 * guarantees, factor and membership plugins.
 */
const AUTH_SCHEMA = {
  account: authAccounts,
  authBudget: authBudgets,
  authDevice: authDevices,
  session: authSessions,
  invitation: invitations,
  teamMember: teamMembers,
  twoFactor: authTwoFactors,
  authTotpUse: authTotpUses,
  user: authUsers,
  verification: authVerifications,
} as const;

function buildAuth(
  database: DBAdapterInstance,
  secrets: readonly { readonly value: string; readonly version: number }[],
  options: SwizzleAuthOptions,
  store: PeopleStore,
  spend: SpendBudget,
  close: () => Promise<void>,
): SwizzleAuth {
  const { links } = options;
  const mailer = links?.mailer ?? null;
  const factors = createAuthFactors();
  const absoluteMs = options.sessionDurationMs ?? DEFAULT_SESSION_DURATION_MS;
  const idleMs = options.sessionIdleTimeoutMs ?? resolveSessionIdleTimeoutMs(process.env);
  const logger = createLogger("swizzle-auth");
  // Typed as the general options, so plugin modules can take the context Better Auth gives them.
  const auth = betterAuth<BetterAuthOptions>({
    advanced: {
      cookiePrefix: "swizzle",
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
      useSecureCookies: options.secureCookies,
    },
    appName: "Swizzle",
    basePath: AUTH_BASE_PATH,
    baseURL: AUTH_BASE_URL,
    database: withHashedSessions(database, { absoluteMs, idleMs }),
    emailAndPassword: {
      enabled: true,
      maxPasswordLength: PASSWORD_LENGTH.max,
      minPasswordLength: PASSWORD_LENGTH.min,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
      onPasswordReset: async ({ user }) => await options.effects.revokeTokens(user.id),
      revokeSessionsOnPasswordReset: true,
      ...(links === null || mailer === null
        ? {}
        : {
            sendResetPassword: async ({ token, user }) =>
              await mailer.send(passwordResetMail(links.origin, user.email, token)),
          }),
    },
    logger: {
      log: (level, message, ...args) =>
        args.length === 0 ? logger[level](message) : logger[level]({ args }, message),
    },
    plugins: [
      factors.plugin,
      swizzleGuarantees(factors, spend),
      swizzleMembership({ effects: options.effects, setupToken: options.setupToken }),
    ],
    // Swizzle's budgets in auth-guarantees.ts survive a restart; the library's limiter would not.
    rateLimit: { enabled: false },
    secrets: [...secrets],
    session: {
      cookieCache: { enabled: false },
      disableSessionRefresh: true,
      expiresIn: Math.floor(absoluteMs / 1000),
    },
    telemetry: { enabled: false },
    trustedOrigins: [...options.trustedOrigins],
    // A database reader must not be able to use a reset link or a sign-in challenge.
    verification: { storeIdentifier: "hashed" },
  });

  const context = () => auth.$context;
  const people = createPeople(store, options.links);
  const findPerson = async (userId: string) => {
    const row = await store.findUser(userId);
    return row === null ? null : authUser(row);
  };
  const results = authResults(findPerson);

  return {
    async close() {
      await close();
    },

    async handle(route, { body, headers }) {
      const sent = new Headers(headers);
      sent.set("content-type", "application/json");
      const response = await auth.handler(
        new Request(`${AUTH_BASE_URL}${AUTH_BASE_PATH}${route}`, {
          body: JSON.stringify(body),
          headers: sent,
          method: "POST",
        }),
      );
      const answer = { headers: response.headers, status: response.status };
      if (response.status >= 400) {
        const failure = await swizzleError(response);
        return {
          headers: response.headers,
          status: API_ERROR_STATUS[failure.error],
          ok: false,
          ...failure,
        };
      }
      const decoded: unknown = await response.json().catch(() => {
        throw unexpectedAnswer(route);
      });
      return { ...answer, ok: true, result: await results[route](decoded) };
    },

    async listSessions(person) {
      const rows = await store.listSessions(person.user.id);
      const now = Date.now();
      return rows
        .filter((row) => row.expiresAt.getTime() > now && row.lastSeenAt.getTime() > now - idleMs)
        .map((row) => ({
          createdAt: row.createdAt.toISOString(),
          current: row.id === person.sessionId,
          expiresAt: row.expiresAt.toISOString(),
          id: row.id,
          lastSeenAt: row.lastSeenAt.toISOString(),
          userAgent: row.userAgent,
        }));
    },

    async revokeAllSessions(userId) {
      await store.deleteSessions(userId);
    },
    async revokeSession(userId, sessionId) {
      return (await store.deleteSessions(userId, sessionId)) > 0;
    },

    setupTokenRequired: options.setupToken !== null,

    async accountsWithoutTwoFactor() {
      return await store.countUsersWithoutTwoFactor();
    },

    createResetLink: people.createResetLink,
    findPerson,
    findInvitation: people.findInvitation,
    invite: people.invite,
    listInvitations: people.listInvitations,
    mailConfigured: mailer !== null,
    removePerson: people.removePerson,
    resetTwoFactor: people.resetTwoFactor,
    revokeInvitation: people.revokeInvitation,

    async setRole(actorId, userId, role) {
      return (await people.setRole(actorId, userId, role)) ? await findPerson(userId) : null;
    },

    async setSuspended(actorId, userId, suspended) {
      return (await people.setSuspended(actorId, userId, suspended))
        ? await findPerson(userId)
        : null;
    },

    async listPeople() {
      return (await store.listUsers()).map(authUser);
    },
    async setupRequired() {
      return !(await store.hasUsers());
    },

    async twoFactorStatus(userId) {
      return await factors.status(await context(), userId);
    },

    async verifySession(headers) {
      const found = await auth.api.getSession({ headers }).catch(() => null);
      if (found === null) return null;
      const row = await store.findUser(found.user.id);
      if (row === null || row.suspendedAt !== null) return null;
      return { sessionId: found.session.id, user: authUser(row) };
    },
  };
}

function authUser(
  row: Pick<
    UserRow,
    "createdAt" | "email" | "id" | "name" | "role" | "suspendedAt" | "twoFactorEnabled"
  >,
): AuthUser {
  return {
    createdAt: row.createdAt.toISOString(),
    email: row.email,
    id: row.id,
    name: row.name,
    role: row.role,
    suspended: Boolean(row.suspendedAt),
    twoFactorEnabled: row.twoFactorEnabled === true,
  };
}

/**
 * How `handle` reads each route's success body. Typed by route, so a route without a reader, or
 * a reader that returns another shape, fails the build.
 */
export function authResults(findPerson: (userId: string) => Promise<AuthUser | null>): {
  readonly [Route in AuthRoute]: (body: unknown) => Promise<AuthResults[Route]>;
} {
  const completed = async (): Promise<AuthActionResult> => ({ success: true });
  return {
    "/sign-up/email": completed,
    "/sign-in/email": async (body) => {
      if (isRecord(body) && body.twoFactorRedirect === true) return { twoFactorRedirect: true };
      const userId = isRecord(body) && isRecord(body.user) ? body.user.id : undefined;
      const user = typeof userId === "string" ? await findPerson(userId) : null;
      if (user === null) throw unexpectedAnswer("/sign-in/email");
      return { user };
    },
    "/sign-out": completed,
    "/change-password": completed,
    "/two-factor/enable": async (body) => {
      if (
        !isRecord(body) ||
        typeof body.totpURI !== "string" ||
        !Array.isArray(body.backupCodes) ||
        !body.backupCodes.every((code) => typeof code === "string")
      )
        throw unexpectedAnswer("/two-factor/enable");
      return { backupCodes: body.backupCodes, totpURI: body.totpURI };
    },
    "/two-factor/verify-totp": completed,
    "/two-factor/verify-backup-code": completed,
    "/two-factor/disable": completed,
    "/request-password-reset": completed,
    "/reset-password": completed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The body is not logged: an enrollment answer holds the person's TOTP secret and recovery codes.
function unexpectedAnswer(route: AuthRoute): CodedError {
  return new CodedError(
    "AUTH_REQUEST_FAILED",
    `Better Auth answered ${route} in a shape Swizzle does not read. Install the Better Auth version packages/db pins, or update its reader in packages/db/src/auth.ts.`,
  );
}

type AuthFailure = { readonly error: ApiErrorCode; readonly message: string };

const INVALID_CODE: AuthFailure = {
  error: "AUTH_CODE_INVALID",
  message:
    "The code is incorrect, expired or already used. Enter a fresh authenticator code or an unused recovery code.",
};
const INVALID_ORIGIN: AuthFailure = {
  error: "AUTH_ORIGIN_FORBIDDEN",
  message: "This page is not allowed to sign in. Open the Swizzle dashboard and try again.",
};
const INVALID_PASSWORD_LENGTH: AuthFailure = {
  error: "AUTH_PASSWORD_INVALID",
  message: `The new password is outside the allowed length. Choose a password between ${PASSWORD_LENGTH.min} and ${PASSWORD_LENGTH.max} characters.`,
};

/** Better Auth failures translated into Swizzle codes and recovery steps. */
const AUTH_ERRORS: Readonly<Record<string, AuthFailure>> = {
  INVALID_BACKUP_CODE: INVALID_CODE,
  INVALID_CODE,
  INVALID_EMAIL_OR_PASSWORD: {
    error: "AUTH_INVALID_CREDENTIALS",
    message: "The email or password is incorrect. Check both and try signing in again.",
  },
  INVALID_ORIGIN,
  INVALID_PASSWORD: {
    error: "AUTH_CURRENT_PASSWORD_INVALID",
    message: "The current password is incorrect. Enter your current password and try again.",
  },
  // Of the forwarded routes, only /reset-password sends it: the link is used, expired or unknown.
  INVALID_TOKEN: {
    error: "AUTH_RESET_LINK_INVALID",
    message: "This password reset link is invalid or expired. Request a new password reset link.",
  },
  INVALID_TWO_FACTOR_COOKIE: {
    error: "AUTH_CODE_CHALLENGE_EXPIRED",
    message:
      "The two-factor sign-in challenge has expired. Sign in again with your email and password.",
  },
  MISSING_OR_NULL_ORIGIN: INVALID_ORIGIN,
  PASSWORD_TOO_LONG: INVALID_PASSWORD_LENGTH,
  PASSWORD_TOO_SHORT: INVALID_PASSWORD_LENGTH,
};

/** Swizzle's `{ error, message }` in place of Better Auth's `{ code, message }`. */
async function swizzleError(response: Response): Promise<AuthFailure> {
  const body: unknown = await response.json().catch(() => null);
  const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
  const fallback = "The authentication request failed. Check your input and try again.";
  if (code.startsWith("AUTH_") && isApiErrorCode(code))
    return {
      error: code,
      message: isRecord(body) && typeof body.message === "string" ? body.message : fallback,
    };
  return (
    AUTH_ERRORS[code] ?? {
      error: response.status >= 500 ? "AUTH_REQUEST_FAILED" : "AUTH_REQUEST_INVALID",
      message: fallback,
    }
  );
}

/** The key Better Auth's `symmetricEncrypt` takes, for re-encryption after a key rotation. */
export function betterAuthSecretConfig(environment: NodeJS.ProcessEnv) {
  const secrets = betterAuthSecrets(environment);
  return {
    currentVersion: secrets[0]?.version ?? 0,
    keys: new Map(secrets.map((secret) => [secret.version, secret.value])),
  };
}

/**
 * One Better Auth secret per Swizzle key, current first. The version is the key's fingerprint,
 * so a value encrypted before a rotation names the key that opens it.
 */
function betterAuthSecrets(
  environment: NodeJS.ProcessEnv,
): readonly { readonly value: string; readonly version: number }[] {
  return resolveSecretEncryptionKeyring(environment).map(({ key }) => ({
    value: createHmac("sha256", key).update("swizzle better-auth secret").digest("base64url"),
    version: Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 7), 16),
  }));
}

function resolveSessionIdleTimeoutMs(environment: NodeJS.ProcessEnv): number {
  const raw = environment.SWIZZLE_SESSION_IDLE_TIMEOUT_MINUTES?.trim();
  if (!raw) return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 24 * 60) {
    throw new Error("SWIZZLE_SESSION_IDLE_TIMEOUT_MINUTES must be an integer between 5 and 1440.");
  }
  return minutes * 60 * 1000;
}

// Passwords are salted scrypt hashes from node:crypto, which runs on the thread pool instead of
// the event loop. Changing a parameter makes every stored hash fail verification.
const PASSWORD_SCHEME = "scrypt";
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_COST = 32_768;
const PASSWORD_BLOCK_SIZE = 8;
const PASSWORD_PARALLELIZATION = 3;
const PASSWORD_MAX_MEMORY = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt);
  return [
    PASSWORD_SCHEME,
    PASSWORD_COST,
    PASSWORD_BLOCK_SIZE,
    PASSWORD_PARALLELIZATION,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [scheme, cost, blockSize, parallelization, saltRaw, hashRaw] = storedHash.split("$");
  if (
    scheme !== PASSWORD_SCHEME ||
    cost !== String(PASSWORD_COST) ||
    blockSize !== String(PASSWORD_BLOCK_SIZE) ||
    parallelization !== String(PASSWORD_PARALLELIZATION) ||
    saltRaw === undefined ||
    hashRaw === undefined
  ) {
    return false;
  }
  const salt = Buffer.from(saltRaw, "base64url");
  const expected = Buffer.from(hashRaw, "base64url");
  if (salt.length !== 16 || expected.length !== PASSWORD_KEY_LENGTH) return false;
  const derived = await scrypt(password, salt);
  return timingSafeEqual(derived, expected);
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
      {
        N: PASSWORD_COST,
        maxmem: PASSWORD_MAX_MEMORY,
        p: PASSWORD_PARALLELIZATION,
        r: PASSWORD_BLOCK_SIZE,
      },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
}

export function createPostgresHostAuth(options: {
  readonly client?: DatabaseClient;
  readonly dashboardOrigin: string;
}): HostAuth {
  const client = options.client ?? createDatabaseClient();
  const people = createPeople(createPostgresPeopleStore(client.db), {
    origin: options.dashboardOrigin,
    mailer: null,
  });
  return {
    close: async () => {
      if (options.client === undefined) await client.close();
    },
    recoverOwner: people.recoverOwner,
  };
}
