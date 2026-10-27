// A project's service accounts and their tokens.

import type {
  CreatedTokenResponse,
  CreateServiceAccountResponse,
  DeleteServiceAccountResponse,
  ScopeInput,
  ServiceAccountsResponse,
  TokenResponse,
} from "../api";
import { json, request } from "./request";

export function serviceAccountsCalls() {
  return {
    async listServiceAccounts(project: string) {
      return (
        await request<ServiceAccountsResponse>(
          `/projects/${encodeURIComponent(project)}/service-accounts`,
        )
      ).serviceAccounts;
    },

    async createServiceAccount(project: string, name: string) {
      return await request<CreateServiceAccountResponse>(
        `/projects/${encodeURIComponent(project)}/service-accounts`,
        json("POST", { name }),
      );
    },

    /** Deletes the account with its grants and tokens. */
    async deleteServiceAccount(project: string, accountId: string) {
      await request<DeleteServiceAccountResponse>(serviceAccountPath(project, accountId), {
        method: "DELETE",
      });
    },

    /** The new value is in the answer only; a service account's scope names no projects. */
    async createServiceAccountToken(
      project: string,
      accountId: string,
      input: {
        readonly name: string;
        readonly expiresAt?: string;
        readonly scope?: Omit<ScopeInput, "projects">;
      },
    ) {
      return await request<CreatedTokenResponse>(
        `${serviceAccountPath(project, accountId)}/tokens`,
        json("POST", input),
      );
    },

    /** A new value under the same name and scope; the old value stops working at once. */
    async rotateServiceAccountToken(project: string, accountId: string, tokenId: string) {
      return await request<CreatedTokenResponse>(
        `${serviceAccountPath(project, accountId)}/tokens/${encodeURIComponent(tokenId)}/rotation`,
        { method: "POST" },
      );
    },

    async revokeServiceAccountToken(project: string, accountId: string, tokenId: string) {
      return await request<TokenResponse>(
        `${serviceAccountPath(project, accountId)}/tokens/${encodeURIComponent(tokenId)}`,
        { method: "DELETE" },
      );
    },
  };
}

function serviceAccountPath(project: string, accountId: string): string {
  return `/projects/${encodeURIComponent(project)}/service-accounts/${encodeURIComponent(accountId)}`;
}
