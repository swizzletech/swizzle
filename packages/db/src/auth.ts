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

export type AuthAnswer<Route extends AuthRoute> = {
  readonly headers: Headers;
  readonly status: number;
} & (
  | { readonly ok: true; readonly result: AuthResults[Route] }
  | { readonly ok: false; readonly error: ApiErrorCode; readonly message: string }
);

const AUTH_BASE_PATH = "/auth";
const AUTH_BASE_URL = "http://swizzle.invalid";

export interface SignedInPerson {
  readonly sessionId: string;
  readonly user: AuthUser;
}

export interface SwizzleAuth {
  handle<Route extends AuthRoute>(
    route: Route,
    request: { readonly body: unknown; readonly headers: Headers },
  ): Promise<AuthAnswer<Route>>;
  verifySession(headers: Headers): Promise<SignedInPerson | null>;
  setupRequired(): Promise<boolean>;
  readonly setupTokenRequired: boolean;
  accountsWithoutTwoFactor(): Promise<number>;
  findPerson(userId: string): Promise<AuthUser | null>;
  listPeople(): Promise<readonly AuthUser[]>;
  listSessions(person: SignedInPerson): Promise<readonly AuthSessionMetadata[]>;
  revokeSession(userId: string, sessionId: string): Promise<boolean>;
  revokeAllSessions(userId: string): Promise<void>;
  twoFactorStatus(userId: string): Promise<TwoFactorStatus>;
  readonly mailConfigured: boolean;
  invite(input: {
    readonly email: string;
    readonly role: InstanceRole;
    readonly grants: readonly PendingGrant[];
    readonly invitedBy: string;
  }): Promise<SentInvitation>;
  findInvitation(token: string): Promise<Invitation | null>;
  listInvitations(): Promise<readonly Invitation[]>;
  revokeInvitation(actorId: string, invitationId: string): Promise<boolean>;
  setRole(actorId: string, userId: string, role: InstanceRole): Promise<AuthUser | null>;
  setSuspended(actorId: string, userId: string, suspended: boolean): Promise<AuthUser | null>;
  removePerson(actorId: string, userId: string): Promise<boolean>;
  resetTwoFactor(actorId: string, userId: string): Promise<boolean>;
  createResetLink(actorId: string, userId: string): Promise<ResetLink | null>;
  close(): Promise<void>;
}

export interface HostAuth {
  recoverOwner(email: string): Promise<OwnerRecovery>;
  close(): Promise<void>;
}

export interface SwizzleAuthOptions {
  readonly setupToken: string | null;
  readonly secureCookies: boolean;
  readonly trustedOrigins: readonly string[];
  readonly sessionDurationMs?: number;
  readonly sessionIdleTimeoutMs?: number;
  readonly effects: AccountEffects;
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
    rateLimit: { enabled: false },
    secrets: [...secrets],
    session: {
      cookieCache: { enabled: false },
      disableSessionRefresh: true,
      expiresIn: Math.floor(absoluteMs / 1000),
    },
    telemetry: { enabled: false },
    trustedOrigins: [...options.trustedOrigins],
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

export function betterAuthSecretConfig(environment: NodeJS.ProcessEnv) {
  const secrets = betterAuthSecrets(environment);
  return {
    currentVersion: secrets[0]?.version ?? 0,
    keys: new Map(secrets.map((secret) => [secret.version, secret.value])),
  };
}

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
