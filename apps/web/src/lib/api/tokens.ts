// The signed-in person's agent tokens.

import type { CreatedTokenResponse, ScopeInput, TokenResponse, TokensResponse } from "../api";
import { request } from "./request";

export function tokensCalls() {
  return {
    async createApiToken(input: {
      readonly name: string;
      readonly expiresAt?: string;
      readonly scope?: ScopeInput;
    }) {
      return await request<CreatedTokenResponse>("/auth/tokens", {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    },

    async listApiTokens() {
      return await request<TokensResponse>("/auth/tokens");
    },

    async revokeApiToken(identifier: string) {
      return await request<TokenResponse>(`/auth/tokens/${encodeURIComponent(identifier)}`, {
        method: "DELETE",
      });
    },
  };
}
