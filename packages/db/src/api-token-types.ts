import type { TokenScope } from "./access.js";
import type { PersonOnRecord } from "./access-store.js";

export type TokenHolder =
  | { readonly kind: "person"; readonly userId: string }
  | { readonly kind: "service-account"; readonly serviceAccountId: string }
  | { readonly kind: "worker"; readonly workerId: string };

export interface StoredApiToken {
  readonly id: string;
  readonly holder: TokenHolder;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scope: TokenScope;
  readonly issuedBy: PersonOnRecord | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface CreatedApiToken extends StoredApiToken {
  readonly token: string;
}

export interface CreateApiTokenInput {
  readonly holder: TokenHolder;
  readonly name: string;
  readonly scope: TokenScope;
  readonly issuedBy: PersonOnRecord | null;
  readonly expiresAt?: string;
  readonly plaintext?: string;
}

export interface ApiTokenStore {
  createToken(input: CreateApiTokenInput): Promise<CreatedApiToken>;
  listTokens(holder: TokenHolder): Promise<readonly StoredApiToken[]>;
  revokeToken(holder: TokenHolder, identifier: string): Promise<StoredApiToken | null>;
  rotateToken(
    holder: TokenHolder,
    identifier: string,
    issuedBy: PersonOnRecord | null,
    plaintext?: string,
  ): Promise<CreatedApiToken | null>;
  revokeAllTokens(userId: string): Promise<void>;
  verifyToken(rawToken: string): Promise<StoredApiToken | null>;
  isLive(tokenId: string): Promise<boolean>;
  close(): Promise<void>;
}
