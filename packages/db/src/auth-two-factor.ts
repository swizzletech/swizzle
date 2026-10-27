/**
 * Better Auth 1.7.12 owns code verification and the twoFactor row. This module owns
 * Swizzle's replay ledger and the integration with the library's challenge and endpoints.
 */
import { createHash } from "node:crypto";

import type {
  AuthContext,
  BetterAuthPlugin,
  DBTransactionAdapter,
  GenericEndpointContext,
} from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";

import type { TwoFactorStatus } from "./auth-types.js";
import { causeCode, PG_ERROR } from "./client.js";

type Context = GenericEndpointContext;

export interface AuthFactors {
  readonly plugin: BetterAuthPlugin;
  user(ctx: Context): Promise<{ readonly id: string; readonly email: string } | null>;
  requireCode(ctx: Context, code: string): Promise<void>;
  status(context: AuthContext, userId: string): Promise<TwoFactorStatus>;
  remove(adapter: DBTransactionAdapter, userId: string): Promise<number>;
}

const TOTP_PERIOD_MS = 30_000;

export function createAuthFactors(): AuthFactors {
  // Swizzle's device and account budgets replace the per-account lockout, which anyone who
  // knows the password could trip to lock the person out of every browser.
  const library = twoFactor({ accountLockout: { enabled: false }, issuer: "Swizzle" });
  const original = library.endpoints.verifyTOTP;
  const verifyTOTP = createAuthEndpoint(original.path, original.options, async (ctx) => {
    const user = await codeUser(ctx);
    const reservation = user === null ? null : await reserveCode(ctx, user.id, ctx.body.code);
    const result = await original({
      context: ctx.context,
      headers: ctx.headers,
      body: ctx.body,
      asResponse: false,
      returnHeaders: true,
    }).catch(async (error: unknown) => {
      if (reservation !== null) {
        await ctx.context.adapter.delete({
          model: "authTotpUse",
          where: [{ field: "id", value: reservation.id }],
        });
      }
      throw error;
    });
    if (reservation !== null) {
      // Verification can cross a step boundary after the reservation was inserted.
      await ctx.context.adapter.update({
        model: "authTotpUse",
        update: { expiresAt: codeExpiry(Date.now()) },
        where: [{ field: "id", value: reservation.id }],
      });
    }
    // The nested endpoint owns the cookies, including the challenge it consumes on sign-in.
    for (const [name, value] of result.headers) {
      if (name !== "set-cookie") ctx.setHeader(name, value);
    }
    for (const cookie of result.headers.getSetCookie()) {
      ctx.responseHeaders.append("set-cookie", cookie);
    }
    return result.response;
  });

  return {
    plugin: {
      ...library,
      endpoints: { ...library.endpoints, verifyTOTP },
      schema: {
        ...library.schema,
        authTotpUse: {
          fields: {
            codeHash: { required: true, type: "string", unique: true },
            expiresAt: { required: true, type: "date" },
            userId: { references: { field: "id", model: "user" }, required: true, type: "string" },
          },
        },
      },
    },
    user: codeUser,

    async remove(adapter, userId) {
      await adapter.deleteMany({
        model: "authTotpUse",
        where: [{ field: "userId", value: userId }],
      });
      return await adapter.deleteMany({
        model: "twoFactor",
        where: [{ field: "userId", value: userId }],
      });
    },

    async requireCode(ctx, code) {
      if (code === "") {
        throw new APIError("UNAUTHORIZED", {
          code: "AUTH_CODE_REQUIRED",
          message: "Enter the code from your authenticator app or a recovery code.",
        });
      }
      const session = await getSessionFromCtx(ctx);
      if (session === null || !(await verifiedFactor(ctx.context, session.user.id))) {
        throw codeRefused();
      }
      const input = {
        context: ctx.context,
        headers: ctx.headers,
        body: { code, trustDevice: false },
      };
      // Direct endpoint calls skip the sign-in hooks. The enclosing operation spends its code
      // budget and keeps its session; Better Auth alone checks and consumes the supplied code.
      if (/^\d{6}$/u.test(code)) await verifyTOTP(input);
      else
        await library.endpoints.verifyBackupCode({
          ...input,
          body: { ...input.body, disableSession: true },
        });
    },

    async status(context, userId) {
      if (!(await verifiedFactor(context, userId))) return { enabled: false };
      const { backupCodes } = await library.endpoints.viewBackupCodes({
        context,
        body: { userId },
      });
      return { enabled: true, recoveryCodesLeft: backupCodes.length };
    },
  };
}

async function verifiedFactor(context: AuthContext, userId: string): Promise<boolean> {
  const factor = await context.adapter.findOne<{ verified: boolean | null }>({
    model: "twoFactor",
    where: [{ field: "userId", value: userId }],
  });
  return factor !== null && factor.verified !== false;
}

/** Better Auth's signed challenge identifies the person between password and code. */
async function codeUser(ctx: Context) {
  const session = await getSessionFromCtx(ctx);
  if (session !== null) return session.user;
  const challenge = await ctx.getSignedCookie(
    ctx.context.createAuthCookie("two_factor").name,
    ctx.context.secret,
  );
  if (!challenge) return null;
  const verification = await ctx.context.internalAdapter.findVerificationValue(challenge);
  if (verification === null || verification.expiresAt < new Date()) return null;
  return await ctx.context.internalAdapter.findUserById(verification.value);
}

/**
 * Reserve before verification so concurrent requests cannot both open a session. Failed checks
 * release only their own reservation. A crash fails closed until expiry. Better Auth accepts
 * steps S-1, S and S+1, so a code submitted in S can stay valid through the end of S+2.
 */
async function reserveCode(ctx: Context, userId: string, code: string) {
  const adapter = ctx.context.adapter;
  const now = Date.now();
  await adapter.deleteMany({
    model: "authTotpUse",
    where: [{ field: "expiresAt", operator: "lte", value: new Date(now) }],
  });
  const codeHash = createHash("sha256").update(`${userId}:${code}`).digest("hex");
  try {
    return await adapter.create<{ id: string }>({
      model: "authTotpUse",
      data: {
        codeHash,
        expiresAt: codeExpiry(now),
        userId,
      },
    });
  } catch (error) {
    if (causeCode(error) === PG_ERROR.uniqueViolation) throw codeRefused();
    throw error;
  }
}

function codeExpiry(now: number): Date {
  return new Date((Math.floor(now / TOTP_PERIOD_MS) + 3) * TOTP_PERIOD_MS);
}

function codeRefused(): APIError {
  return new APIError("UNAUTHORIZED", {
    code: "AUTH_CODE_INVALID",
    message: "The code is incorrect, expired or already used.",
  });
}
