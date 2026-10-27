// The account records auth.ts serves, apart from it so that the @swizzle/db root names them
// without loading Better Auth, drizzle or pg. The dashboard and the HTTP contract read them.

import type { InstanceRole } from "./access.js";

export interface AuthUser {
  readonly createdAt: string;
  readonly email: string;
  readonly id: string;
  readonly name: string;
  /** The instance role: owners and admins see every project (ADR 0014). */
  readonly role: InstanceRole;
  /** A suspended person has no session and no working token until reactivated. */
  readonly suspended: boolean;
  readonly twoFactorEnabled: boolean;
}

/** One of a person's signed-in browsers; `current` is the one asking. */
export interface AuthSessionMetadata {
  readonly createdAt: string;
  readonly current: boolean;
  readonly expiresAt: string;
  readonly id: string;
  readonly lastSeenAt: string;
  /** The browser's User-Agent at sign-in, so the person can tell their devices apart. */
  readonly userAgent: string | null;
}

export type TwoFactorStatus =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly recoveryCodesLeft: number };

/** A completed auth action whose result is carried by cookies or account state. */
export interface AuthActionResult {
  readonly success: true;
}

/** What POST /auth/sign-in/email answers: signed in, or a code to enter first. */
export type SignInResult = { readonly twoFactorRedirect: true } | { readonly user: AuthUser };

/**
 * What POST /auth/two-factor/enable answers: the authenticator app's URI and the recovery codes,
 * shown while the person sets up the app and never again.
 */
export interface TwoFactorEnrollment {
  readonly backupCodes: readonly string[];
  readonly totpURI: string;
}
