// The signed-in person's own account. `sessionApi` holds the calls the dashboard makes before
// it knows its environment: signing in and asking which environments the instance lists.

import type {
  AuthStatusResponse,
  EnvironmentsResponse,
  InstanceEnvironments,
  InvitationOfferResponse,
  NoContentResponse,
  SessionsResponse,
  SignInResponse,
  TwoFactorEnrollmentResponse,
  TwoFactorResponse,
} from "../api";
import { json, request } from "./request";

/**
 * The calls the dashboard makes before it knows its environment: signing in, and asking the
 * instance which environments it lists. Every other call goes through createDashboardApiClient.
 */
export const sessionApi = {
  async getAuthStatus() {
    return await request<AuthStatusResponse>(`/auth/status?requestTime=${Date.now()}`, {
      cache: "no-store",
    });
  },

  async getInstanceEnvironments(): Promise<InstanceEnvironments> {
    const { defaultEnvironment, environments } =
      await request<EnvironmentsResponse>("/environments");
    return { defaultEnvironment, names: environments.map((environment) => environment.name) };
  },

  async signIn(input: { readonly email: string; readonly password: string }) {
    return await request<SignInResponse>("/auth/sign-in/email", {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  },

  /** The second sign-in step: a 6-digit code from the app, or a recovery code. */
  async verifySignInCode(code: string) {
    await request<unknown>(
      isAppCode(code) ? "/auth/two-factor/verify-totp" : "/auth/two-factor/verify-backup-code",
      {
        body: JSON.stringify({ code: code.trim() }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
  },

  async getInvitation(token: string) {
    return await request<InvitationOfferResponse>("/auth/invitation", json("POST", { token }));
  },

  /** Creates the invited account and signs this browser in. */
  async acceptInvitation(input: {
    readonly email: string;
    readonly name: string;
    readonly password: string;
    readonly token: string;
  }) {
    const { token, ...account } = input;
    await request<unknown>("/auth/sign-up/email", {
      ...json("POST", account),
      headers: { "Content-Type": "application/json", "X-Swizzle-Invitation-Token": token },
    });
  },

  /** Mails a reset link when an account has this address; answers the same when none has. */
  async requestPasswordReset(email: string) {
    await request<unknown>("/auth/request-password-reset", json("POST", { email }));
  },

  async resetPassword(input: { readonly newPassword: string; readonly token: string }) {
    await request<unknown>("/auth/reset-password", json("POST", input));
  },

  /** Starts setup; two-factor sign-in is on once `confirmTwoFactor` accepts a code. */
  async enableTwoFactor(input: { readonly password: string }) {
    return await request<TwoFactorEnrollmentResponse>(
      "/auth/two-factor/enable",
      json("POST", input),
    );
  },

  async confirmTwoFactor(code: string) {
    await request<unknown>("/auth/two-factor/verify-totp", json("POST", { code: code.trim() }));
  },

  /** Creates the first account and signs this browser in. */
  async setUp(input: {
    readonly email: string;
    readonly name: string;
    readonly password: string;
    readonly setupToken?: string;
  }) {
    const { setupToken, ...account } = input;
    await request<unknown>("/auth/sign-up/email", {
      body: JSON.stringify(account),
      headers: {
        "Content-Type": "application/json",
        ...(setupToken === undefined ? {} : { "X-Swizzle-Setup-Token": setupToken }),
      },
      method: "POST",
    });
  },
};

function isAppCode(code: string): boolean {
  return /^\d{6}$/u.test(code.trim());
}

export function accountCalls() {
  return {
    /** `code` is the second factor, needed while two-factor sign-in is on. Signs out every other browser. */
    async changePassword(input: {
      readonly code: string;
      readonly currentPassword: string;
      readonly newPassword: string;
    }) {
      await request<unknown>("/auth/change-password", {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    },

    async getTwoFactor() {
      return await request<TwoFactorResponse>("/auth/two-factor");
    },

    async disableTwoFactor(input: { readonly code: string; readonly password: string }) {
      await request<unknown>("/auth/two-factor/disable", {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    },

    async logout() {
      await request<unknown>("/auth/sign-out", {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    },

    async revokeAllSessions() {
      await request<NoContentResponse>("/auth/sessions/revoke-all", { method: "POST" });
    },

    async revokeSession(sessionId: string) {
      await request<NoContentResponse>(`/auth/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    },

    async listSessions() {
      return await request<SessionsResponse>("/auth/sessions");
    },
  };
}
