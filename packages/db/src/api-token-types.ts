import type { TokenScope } from "./access.js";
import type { PersonOnRecord } from "./access-store.js";

/**
 * Who a token acts as. An agent token acts as its person, with their rights at the time of each
 * request; a service account token acts as the account, whoever minted it. A worker token
 * authorizes only the worker protocol, with the grants of its registered machine.
 */
export type TokenHolder =
  | { readonly kind: "person"; readonly userId: string }
  | { readonly kind: "service-account"; readonly serviceAccountId: string }
  | { readonly kind: "worker"; readonly workerId: string };

export interface StoredApiToken {
  readonly id: string;
  readonly holder: TokenHolder;
  readonly name: string;
  readonly tokenPrefix: string;
  /** Fixed when the token is minted; access.ts caps every request by it. */
  readonly scope: TokenScope;
  /** The person who minted it, kept after they are removed; null for a worker's credential. */
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
  /** A configured local credential; renewal supplies its durable candidate to rotateToken. */
  readonly plaintext?: string;
}

export interface ApiTokenStore {
  createToken(input: CreateApiTokenInput): Promise<CreatedApiToken>;
  /** The holder's tokens, newest first, revoked ones included. */
  listTokens(holder: TokenHolder): Promise<readonly StoredApiToken[]>;
  /** By id or name, among the holder's live tokens; null when it has no such token. */
  revokeToken(holder: TokenHolder, identifier: string): Promise<StoredApiToken | null>;
  /**
   * Mints a token with the same name, scope and lifetime and revokes the old one in one commit;
   * null when the holder has no such live token. A supplied candidate supports durable worker renewal.
   */
  rotateToken(
    holder: TokenHolder,
    identifier: string,
    issuedBy: PersonOnRecord | null,
    plaintext?: string,
  ): Promise<CreatedApiToken | null>;
  /** Revokes every token of the person, as a password reset does. */
  revokeAllTokens(userId: string): Promise<void>;
  verifyToken(rawToken: string): Promise<StoredApiToken | null>;
  /** Whether the token is still neither revoked nor expired, for a request that outlives either. */
  isLive(tokenId: string): Promise<boolean>;
  close(): Promise<void>;
}
