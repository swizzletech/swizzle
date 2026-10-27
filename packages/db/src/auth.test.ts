import type { Mailer } from "@swizzle/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { SwizzleAuthOptions } from "./auth.js";
import { authResults } from "./auth.js";
import type { AuthUser } from "./auth-types.js";

const ADA: AuthUser = {
  createdAt: "2026-10-01T00:00:00.000Z",
  email: "ada@example.com",
  id: "ada",
  name: "Ada",
  role: "owner",
  suspended: false,
  twoFactorEnabled: false,
};
const results = authResults(async (userId) => (userId === ADA.id ? ADA : null));

describe("the success answers a Swizzle client reads", () => {
  it.each([
    "/sign-up/email",
    "/sign-out",
    "/change-password",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
    "/two-factor/disable",
    "/request-password-reset",
    "/reset-password",
  ] as const)("acknowledges %s without exposing library JSON", async (route) => {
    expect(
      await results[route]({
        token: "library-token",
        user: { id: "ada", emailVerified: true, image: null, updatedAt: "library-date" },
        redirect: true,
        message: "library-message",
      }),
    ).toEqual({ success: true });
  });

  it("keeps only the fields of the Swizzle record", async () => {
    expect(await results["/sign-in/email"]({ redirect: false, user: { id: "ada" } })).toEqual({
      user: ADA,
    });
    expect(
      await results["/sign-in/email"]({ twoFactorMethods: ["totp"], twoFactorRedirect: true }),
    ).toEqual({ twoFactorRedirect: true });
    expect(
      await results["/two-factor/enable"]({ backupCodes: ["a1"], method: "totp", totpURI: "u" }),
    ).toEqual({ backupCodes: ["a1"], totpURI: "u" });
  });

  it.each([
    { route: "/sign-in/email", body: { redirect: false, user: { id: "gone" } } },
    { route: "/sign-in/email", body: { signedIn: true } },
    { route: "/two-factor/enable", body: { backupCodes: ["a1"], uri: "u" } },
    { route: "/two-factor/enable", body: { backupCodes: [1], totpURI: "u" } },
  ] as const)("refuses $route answering $body", async ({ route, body }) => {
    await expect(results[route](body)).rejects.toMatchObject({
      code: "AUTH_REQUEST_FAILED",
      message: `Better Auth answered ${route} in a shape Swizzle does not read. Install the Better Auth version packages/db pins, or update its reader in packages/db/src/auth.ts.`,
    });
  });
});

it("requires an origin whenever account mail is configured", () => {
  expectTypeOf<{ mailer: Mailer }>().not.toExtend<NonNullable<SwizzleAuthOptions["links"]>>();
  expectTypeOf<{ origin: null; mailer: Mailer }>().not.toExtend<
    NonNullable<SwizzleAuthOptions["links"]>
  >();
  expectTypeOf<{ origin: string; mailer: Mailer | null }>().toExtend<
    NonNullable<SwizzleAuthOptions["links"]>
  >();
});
