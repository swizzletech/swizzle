import type { CredentialGrant, CredentialRight, CredentialTarget, Subject } from "../access.js";
import type { CredentialHolder } from "../access-holders.js";
import type { ProjectRef } from "../project-ref.js";

/** Where a secret or a connection lives: one environment of one project. */
export interface CredentialPlace {
  readonly environment: string;
  readonly projectId: string;
}

/**
 * Whether a credential an active deployment declares reaches its runs. `bound`: the deployment
 * bound it at publish. `unbound`: what it bound is gone, but a deploy in the automation's project
 * would find one of the name now. `missing`: a deploy would find none. Both need a new deploy.
 */
export type CredentialState = "bound" | "missing" | "unbound";

/** A secret or a connection by its id, its name and the place that owns it. */
export interface StoredCredential extends CredentialTarget {
  readonly name: string;
}

/** A credential offered to another project; it binds there once an admin of that project accepted. */
export interface CredentialShare {
  readonly shareId: string;
  readonly credential: Omit<StoredCredential, "projectId">;
  /** The project the credential is offered to. */
  readonly project: ProjectRef;
  /** The project that owns the credential. */
  readonly credentialProject: ProjectRef;
  readonly offeredBy: string | null;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
  readonly createdAt: string;
}

/** Who holds which right on one credential, and where it is shared. */
export interface CredentialAccess {
  readonly credential: StoredCredential;
  readonly grants: readonly CredentialGrant[];
  readonly shares: readonly CredentialShare[];
}

/** A credential its project shares with others, with each share; the project tab lists these. */
export interface SharedCredential {
  readonly credential: StoredCredential;
  readonly shares: readonly CredentialShare[];
}

/**
 * GET /credentials/:kind/:name/access: who may use and manage a credential, for anyone with a
 * right on it. Only a caller whose `right` is manage may change its grants and shares.
 */
export interface CredentialAccessView {
  readonly credential: StoredCredential;
  readonly right: CredentialRight;
  readonly holders: readonly CredentialHolder[];
  readonly grants: readonly CredentialGrant[];
  readonly shares: readonly CredentialShare[];
  /** The service accounts of the owning project, which a grant may name. */
  readonly serviceAccounts: readonly { readonly id: string; readonly name: string }[];
}

/**
 * The credential a declared name binds in a deployment to a place: the place's own, else one
 * shared into the place's project and accepted there (`shareId`).
 */
export interface DeploymentCredential {
  readonly credential: StoredCredential;
  readonly shareId: string | null;
}

/** The names a deployment to `place` declares. */
export interface DeclaredCredentials {
  readonly place: CredentialPlace;
  readonly secrets: readonly string[];
  readonly connections: readonly string[];
}

export interface FindSecretDeclarationCollisionsInput extends CredentialPlace {
  readonly excludeAutomationSlug?: string;
  readonly secretNames: readonly string[];
}

export interface SecretDeclarationCollision {
  readonly automationNames: readonly string[];
  readonly automationSlugs: readonly string[];
  readonly secretName: string;
}

export interface StoredSecret {
  readonly algorithm: string;
  readonly createdAt: string;
  readonly environment: string;
  readonly id: string;
  readonly keyVersion: string;
  readonly name: string;
  readonly projectId: string;
  readonly secretVersion: number;
  readonly updatedAt: string;
}

export interface ResolvedSecret extends StoredSecret {
  readonly value: string;
}

/** Which version of a secret one run attempt or API check received; never its value. */
export interface StoredSecretUsage {
  readonly algorithm: string;
  readonly environment: string;
  readonly injectedAt: string;
  readonly keyVersion: string;
  readonly secretName: string;
  readonly secretVersion: number;
}

export interface StoredRunExecutionSecretUsage extends StoredSecretUsage {
  readonly executionNumber: number;
  readonly runId: string;
}

export type ConnectionStatus = "pending" | "active" | "error" | "revoked";

/** A declared connection: the bound account's status, or why the deployment holds none. */
export type DeclaredConnectionStatus = ConnectionStatus | Exclude<CredentialState, "bound">;

/**
 * Decrypted OAuth client credentials for a single connection. The client
 * id/secret (and, for custom providers, the endpoints) are used to build the
 * authorization URL and to exchange/refresh tokens. Never leaves the API/worker.
 */
export interface ConnectionCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly provider: string;
  readonly providerConfig: Record<string, unknown> | null;
}

export interface StoredConnection {
  readonly accessTokenExpiresAt: string | null;
  /** True while an authorization attempt is in flight (state not yet consumed/expired). */
  readonly authorizationPending: boolean;
  /** Public OAuth client id registered on the provider; safe to display. */
  readonly clientId: string;
  readonly createdAt: string;
  readonly environment: string;
  readonly id: string;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastRefreshedAt: string | null;
  readonly name: string;
  readonly projectId: string;
  readonly provider: string;
  readonly providerConfig: Record<string, unknown> | null;
  readonly scopes: readonly string[];
  readonly status: ConnectionStatus;
  readonly tokenVersion: number;
  readonly updatedAt: string;
}

/** Decrypted token material. Never leaves the API/worker process. */
export interface ConnectionTokenPayload {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string | null;
  readonly obtainedAt: string;
  readonly refreshToken: string | null;
  readonly tokenType: string;
}

export interface BeginConnectionAuthorizationInput extends CredentialPlace {
  /** Public OAuth client id registered on the provider. */
  readonly clientId: string;
  /** Plaintext client secret; the store encrypts it before persisting. */
  readonly clientSecret: string;
  readonly codeVerifier: string;
  /** Whoever creates the connection, a person or a service account, gets a manage grant in the same transaction. */
  readonly creator?: Subject;
  readonly expiresAt: string;
  readonly name: string;
  readonly provider: string;
  readonly providerConfig?: Record<string, unknown> | null;
  /**
   * The id of the connection the caller checked and re-authorizes, or null for a new one. A
   * different row by the time of the write fails with CREDENTIAL_CHANGED, so a right checked on
   * one connection never authorizes another created, deleted or replaced meanwhile.
   */
  readonly reauthorizes: string | null;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly stateHash: string;
}

/**
 * Snapshot handed back when a callback consumes its pending authorization.
 * The code exchange happens outside the transaction; the caller persists the
 * outcome with `storeConnectionTokens` or `markConnectionError`.
 */
export interface ConsumedConnectionAuthorization {
  readonly clientId: string;
  /** The connection the authorization began on; the outcome is written to it alone. */
  readonly connectionId: string;
  /** Decrypted client secret, used to exchange the authorization code. */
  readonly clientSecret: string;
  readonly codeVerifier: string;
  /** Refresh token from the previous payload, for providers that omit it on re-consent. */
  readonly existingRefreshToken: string | null;
  readonly provider: string;
  readonly providerConfig: Record<string, unknown> | null;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** True when the connection was active before this authorization attempt. */
  readonly wasActive: boolean;
}

export interface StoreConnectionTokensInput {
  readonly connectionId: string;
  readonly payload: ConnectionTokenPayload;
  readonly scopes?: readonly string[];
}

export interface MarkConnectionErrorInput {
  readonly connectionId: string;
  readonly errorCode: string;
  /** Keep an `active` connection active (e.g. abandoned reconnect attempt). */
  readonly preserveActive?: boolean;
}

export type ConnectionRefreshOutcome =
  | { readonly ok: true; readonly payload: ConnectionTokenPayload }
  | { readonly ok: false; readonly permanent: boolean; readonly errorCode: string };

export interface ResolveConnectionTokenInput {
  /** By id, so a connection recreated under the same name is not the one a deployment bound. */
  readonly connectionId: string;
  /**
   * Called while holding the row lock when the access token is missing or
   * expires within `refreshSkewMs`. Must not throw; provider failures are
   * reported through the outcome so the store can persist status changes.
   */
  readonly refresh: (
    connection: StoredConnection,
    payload: ConnectionTokenPayload,
  ) => Promise<ConnectionRefreshOutcome>;
  readonly refreshSkewMs: number;
}

export type ResolveConnectionTokenResult =
  | { readonly outcome: "missing" }
  | { readonly outcome: "inactive"; readonly connection: StoredConnection }
  | {
      readonly outcome: "refresh-failed";
      readonly connection: StoredConnection;
      readonly errorCode: string;
      readonly permanent: boolean;
    }
  | {
      readonly outcome: "resolved";
      readonly accessToken: string;
      readonly accessTokenExpiresAt: string | null;
      readonly connection: StoredConnection;
      readonly refreshed: boolean;
    };

export interface DeleteConnectionResult {
  readonly deleted: boolean;
  /** Client credentials and token payload of the deleted connection, for best-effort revocation. */
  readonly credentials: ConnectionCredentials | null;
  readonly payload: ConnectionTokenPayload | null;
}

/** Which token version of a connection one run attempt or API check received; never the token. */
export interface StoredConnectionUsage {
  readonly connectionName: string;
  readonly environment: string;
  readonly injectedAt: string;
  readonly provider: string;
  readonly tokenVersion: number;
}

export interface StoredRunExecutionConnectionUsage extends StoredConnectionUsage {
  readonly executionNumber: number;
  readonly runId: string;
}

export interface RecordRunExecutionConnectionUsagesInput {
  readonly executionNumber: number;
  readonly connectionUsages: readonly {
    readonly connectionName: string;
    readonly environment: string;
    readonly provider: string;
    readonly tokenVersion: number;
  }[];
  readonly injectedAt?: string;
  readonly runId: string;
}

export interface UpsertSecretInput extends CredentialPlace {
  /** Whoever creates it, a person or a service account, gets a manage grant in the same transaction; an update grants nothing. */
  readonly creator?: Subject;
  readonly name: string;
  readonly value: string;
  /**
   * The secret this write may replace, checked in the write's transaction. `null` creates only and
   * fails with `SECRET_ALREADY_EXISTS` when the name is taken; an id replaces only that secret and
   * fails with `CREDENTIAL_CHANGED` when another one, or none, holds the name. Absent, the write
   * creates or replaces whatever holds the name.
   */
  readonly replaces?: string | null;
}

export interface RecordRunExecutionSecretUsagesInput {
  readonly executionNumber: number;
  readonly injectedAt?: string;
  readonly runId: string;
  readonly secretUsages: readonly ResolvedSecret[];
}

/** Credential reads include their owning project from the same query. */
export interface SecretView extends StoredSecret {
  readonly project: ProjectRef;
}
export interface ConnectionView extends StoredConnection {
  readonly project: ProjectRef;
}
