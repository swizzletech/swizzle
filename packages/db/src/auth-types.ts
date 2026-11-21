import type { InstanceRole } from "./access.js";

export interface AuthUser {
  readonly createdAt: string;
  readonly email: string;
  readonly id: string;
  readonly name: string;
  readonly role: InstanceRole;
  readonly suspended: boolean;
  readonly twoFactorEnabled: boolean;
}

export interface AuthSessionMetadata {
  readonly createdAt: string;
  readonly current: boolean;
  readonly expiresAt: string;
  readonly id: string;
  readonly lastSeenAt: string;
  readonly userAgent: string | null;
}

export type TwoFactorStatus =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly recoveryCodesLeft: number };

export interface AuthActionResult {
  readonly success: true;
}

export type SignInResult = { readonly twoFactorRedirect: true } | { readonly user: AuthUser };

export interface TwoFactorEnrollment {
  readonly backupCodes: readonly string[];
  readonly totpURI: string;
}
