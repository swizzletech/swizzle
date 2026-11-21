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

  async requestPasswordReset(email: string) {
    await request<unknown>("/auth/request-password-reset", json("POST", { email }));
  },

  async resetPassword(input: { readonly newPassword: string; readonly token: string }) {
    await request<unknown>("/auth/reset-password", json("POST", input));
  },

  async enableTwoFactor(input: { readonly password: string }) {
    return await request<TwoFactorEnrollmentResponse>(
      "/auth/two-factor/enable",
      json("POST", input),
    );
  },

  async confirmTwoFactor(code: string) {
    await request<unknown>("/auth/two-factor/verify-totp", json("POST", { code: code.trim() }));
  },

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
