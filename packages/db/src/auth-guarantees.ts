import { createHash, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { AuthFactors } from "./auth-two-factor.js";
import type { SpendBudget } from "./budgets.js";

const SIGN_IN_BUDGETS = {
  address: { limit: 30, windowMs: 60_000 },
  code: { limit: 5, windowMs: 15 * 60_000 },
  password: { limit: 5, windowMs: 60_000 },
  mail: { limit: 3, windowMs: 15 * 60_000 },
  signUp: { limit: 10, windowMs: 5 * 60_000 },
} as const;

type BudgetName = keyof typeof SIGN_IN_BUDGETS;

type BudgetScope = { readonly deviceId: string } | { readonly email: string };

export const CLIENT_ADDRESS_HEADER = "x-swizzle-client-address";

const DEVICE_COOKIE = "device";
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

const SIGN_OUT_OTHERS = "swizzleSignOutOthers";

const SIGNS_IN = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

type Context = GenericEndpointContext;

export function swizzleGuarantees(
  factors: AuthFactors,
  spendBudget: SpendBudget,
): BetterAuthPlugin {
  const spend = async (
    _ctx: Context,
    budget: BudgetName,
    scope: BudgetScope | { readonly address: string },
  ) => {
    const { limit, windowMs } = SIGN_IN_BUDGETS[budget];
    const result = await spendBudget(`${budget}:${JSON.stringify(scope)}`, limit, windowMs);
    if (!result.allowed)
      throw refusal(
        "TOO_MANY_REQUESTS",
        "AUTH_RATE_LIMITED",
        "Too many authentication attempts. Try again shortly.",
        {
          "Retry-After": String(
            Math.max(1, Math.ceil((result.windowEndsAt.getTime() - Date.now()) / 1000)),
          ),
        },
      );
  };
  const before = (path: string, handler: (ctx: Context) => Promise<unknown>) => ({
    handler: createAuthMiddleware(handler),
    matcher: (ctx: { path?: string }) => ctx.path === path,
  });

  return {
    id: "swizzle-guarantees",
    schema: {
      authBudget: {
        fields: {
          attempts: { required: true, type: "number" },
          keyHash: { required: true, type: "string", unique: true },
          windowEndsAt: { required: true, type: "date" },
        },
      },
      authDevice: {
        fields: {
          createdAt: { required: true, type: "date" },
          lastSignInAt: { required: true, type: "date" },
          tokenHash: { required: true, type: "string", unique: true },
          userId: { references: { field: "id", model: "user" }, required: true, type: "string" },
        },
      },
      session: {
        fields: {
          lastSeenAt: { input: false, required: false, type: "date" },
          signedInAt: { input: false, required: false, type: "date" },
        },
      },
    },
    hooks: {
      before: [
        before("/sign-up/email", async (ctx) => {
          await spend(ctx, "signUp", { address: clientAddress(ctx) });
        }),

        before("/request-password-reset", async (ctx) => {
          await spend(ctx, "address", { address: clientAddress(ctx) });
          await spend(ctx, "mail", { email: normalizeEmail(bodyField(ctx, "email")) });
        }),

        before("/reset-password", async (ctx) => {
          await spend(ctx, "address", { address: clientAddress(ctx) });
        }),

        before("/sign-in/email", async (ctx) => {
          const email = normalizeEmail(bodyField(ctx, "email"));
          const device = await knownDevice(ctx, (user) => user.email === email);
          if (device === null) {
            await spend(ctx, "address", { address: clientAddress(ctx) });
            await spend(ctx, "password", { email });
          } else {
            await spend(ctx, "password", device);
          }
        }),

        before("/two-factor/verify-totp", async (ctx) => {
          const session = await getSessionFromCtx(ctx);
          const user = session?.user ?? (await factors.user(ctx));
          if (user === null) return;
          await spend(ctx, "code", await scopeOf(ctx, user));
          const turnsOn = session !== null && session.user.twoFactorEnabled !== true;
          return {
            context: {
              body: { ...bodyObject(ctx), trustDevice: false },
              ...(turnsOn ? { context: { [SIGN_OUT_OTHERS]: true } } : {}),
            },
          };
        }),

        before("/two-factor/verify-backup-code", async (ctx) => {
          const user = await factors.user(ctx);
          if (user === null) return;
          await spend(ctx, "code", await scopeOf(ctx, user));
          return untrusted(ctx);
        }),

        before("/change-password", async (ctx) => {
          const session = await getSessionFromCtx(ctx);
          if (session === null) return;
          const scope = await scopeOf(ctx, session.user);
          await spend(ctx, "password", scope);
          return {
            context: {
              body: { ...bodyObject(ctx), revokeOtherSessions: true },
              context: stepUpAfterPassword(
                ctx,
                factors,
                scope,
                session.user.twoFactorEnabled === true,
                spend,
              ),
            },
          };
        }),

        before("/two-factor/enable", async (ctx) => {
          const session = await getSessionFromCtx(ctx);
          if (session === null) return;
          await spend(ctx, "password", await scopeOf(ctx, session.user));
        }),

        before("/two-factor/disable", async (ctx) => {
          const session = await getSessionFromCtx(ctx);
          if (session === null) return;
          const scope = await scopeOf(ctx, session.user);
          await spend(ctx, "password", scope);
          return {
            context: {
              context: {
                ...stepUpAfterPassword(ctx, factors, scope, true, spend),
                [SIGN_OUT_OTHERS]: true,
              },
            },
          };
        }),
      ],
      after: [
        {
          handler: createAuthMiddleware(async (ctx) => {
            const userId = ctx.context.newSession?.user.id;
            if (userId !== undefined) await rememberDevice(ctx, userId);
          }),
          matcher: (ctx) => SIGNS_IN.has(ctx.path ?? ""),
        },
        {
          handler: createAuthMiddleware(async (ctx) => {
            const kept = ctx.context.newSession;
            const marked = (ctx.context as { [SIGN_OUT_OTHERS]?: boolean })[SIGN_OUT_OTHERS];
            if (marked !== true || !kept) return;
            await ctx.context.adapter.deleteMany({
              model: "session",
              where: [
                { field: "userId", value: kept.user.id },
                { field: "id", operator: "ne", value: kept.session.id },
              ],
            });
          }),
          matcher: (ctx) =>
            ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/disable",
        },
        {
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (returned === null || typeof returned !== "object" || !("token" in returned)) return;
            if (returned instanceof Error || returned instanceof Response) return;
            const { token: _token, ...rest } = returned as Record<string, unknown>;
            return ctx.json(rest);
          }),
          matcher: () => true,
        },
      ],
    },
  };
}

export function refusal(
  status: "CONFLICT" | "FORBIDDEN" | "NOT_FOUND" | "TOO_MANY_REQUESTS" | "UNAUTHORIZED",
  code: string,
  message: string,
  headers: Record<string, string> = {},
): APIError {
  return new APIError(status, { code, message }, headers);
}

interface ScopedUser {
  readonly email: string;
  readonly id: string;
}

async function scopeOf(ctx: Context, user: ScopedUser): Promise<BudgetScope> {
  return (await knownDevice(ctx, (owner) => owner.id === user.id)) ?? { email: user.email };
}

async function knownDevice(
  ctx: Context,
  belongsTo: (user: ScopedUser) => boolean,
): Promise<{ readonly deviceId: string } | null> {
  const token = ctx.getCookie(deviceCookie(ctx).name);
  if (token === null || token === undefined || token.length < 32) return null;
  const device = await ctx.context.adapter.findOne<{ id: string; userId: string }>({
    model: "authDevice",
    where: [{ field: "tokenHash", value: sha256(token) }],
  });
  if (device === null) return null;
  const user = await ctx.context.internalAdapter.findUserById(device.userId);
  return user !== null && belongsTo(user) ? { deviceId: device.id } : null;
}

async function rememberDevice(ctx: Context, userId: string): Promise<void> {
  const cookie = deviceCookie(ctx);
  const presented = ctx.getCookie(cookie.name);
  const now = new Date();
  if (presented !== null && presented !== undefined) {
    const kept = await ctx.context.adapter.update({
      model: "authDevice",
      update: { lastSignInAt: now },
      where: [
        { field: "tokenHash", value: sha256(presented) },
        { field: "userId", value: userId },
      ],
    });
    if (kept !== null) return;
  }
  const token = `swzd_${randomToken()}`;
  await ctx.context.adapter.create({
    data: { createdAt: now, lastSignInAt: now, tokenHash: sha256(token), userId },
    model: "authDevice",
  });
  ctx.setCookie(cookie.name, token, cookie.attributes);
}

function deviceCookie(ctx: Context) {
  return ctx.context.createAuthCookie(DEVICE_COOKIE, { maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS });
}

function untrusted(ctx: Context) {
  return { context: { body: { ...bodyObject(ctx), trustDevice: false } } };
}

function stepUpAfterPassword(
  ctx: Context,
  factors: AuthFactors,
  scope: BudgetScope,
  required: boolean,
  spend: (ctx: Context, budget: BudgetName, scope: BudgetScope) => Promise<void>,
) {
  if (!required) return {};
  const password = ctx.context.password;
  return {
    password: {
      ...password,
      verify: async (input: Parameters<typeof password.verify>[0]) => {
        const valid = await password.verify(input);
        if (valid) {
          const code = bodyField(ctx, "code").trim();
          if (code !== "") await spend(ctx, "code", scope);
          await factors.requireCode(ctx, code);
        }
        return valid;
      },
    },
  };
}

function clientAddress(ctx: Context): string {
  return ctx.headers?.get(CLIENT_ADDRESS_HEADER) ?? "server";
}

function bodyObject(ctx: Context): Record<string, unknown> {
  const body: unknown = ctx.body;
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export function bodyField(ctx: Context, name: string): string {
  const value = bodyObject(ctx)[name];
  return typeof value === "string" ? value : "";
}

export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sameSecret(provided: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
