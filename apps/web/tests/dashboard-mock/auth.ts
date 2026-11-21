import type { SignInResponse } from "../../src/lib/api";
import { ago, MINUTE, type MockRoute } from "./route";

const PERSON = {
  createdAt: ago(30 * 24 * 60 * MINUTE),
  email: "ada@example.com",
  id: "person-1",
  name: "Ada",
  role: "member",
  suspended: false,
  twoFactorEnabled: false,
} as const;

export interface MockTwoFactor {
  readonly expireFirstChallenge?: boolean;
  readonly recoveryCode: string;
  readonly totp: string;
}

export interface MockAuthOptions {
  readonly authenticated?: boolean;
  readonly twoFactor?: MockTwoFactor;
}

export function auth(options: MockAuthOptions) {
  let authenticated = options.authenticated !== false;
  let challenged = false;
  let challengeExpires = options.twoFactor?.expireFirstChallenge === true;
  return {
    get authenticated() {
      return authenticated;
    },
    handle({ apiError, body, is, json, pathname }: MockRoute) {
      if (is("GET", /^\/auth\/status$/u)) {
        return json({
          authenticated,
          setupRequired: false,
          setupTokenRequired: false,
          user: authenticated ? PERSON : null,
        });
      }
      if (is("POST", /^\/auth\/sign-in\/email$/u)) {
        if (options.twoFactor !== undefined) {
          challenged = true;
          return json({ twoFactorRedirect: true } satisfies SignInResponse);
        }
        authenticated = true;
        return json({ user: PERSON } satisfies SignInResponse);
      }
      if (is("POST", /^\/auth\/two-factor\/verify-(totp|backup-code)$/u)) {
        const expected = pathname.endsWith("totp")
          ? options.twoFactor?.totp
          : options.twoFactor?.recoveryCode;
        if (!challenged || challengeExpires) {
          challenged = false;
          challengeExpires = false;
          return apiError("AUTH_CODE_CHALLENGE_EXPIRED", 401, "Sign in again.");
        }
        if ((body as { code?: string } | null)?.code !== expected) {
          return apiError("AUTH_CODE_INVALID", 401, "Invalid code.");
        }
        challenged = false;
        authenticated = true;
        return json({ user: PERSON });
      }
      if (!authenticated) return undefined;
      if (is("GET", /^\/auth\/sessions$/u)) return json({ sessions: [] });
      if (is("GET", /^\/auth\/two-factor$/u)) return json({ enabled: false });
      return undefined;
    },
  };
}
