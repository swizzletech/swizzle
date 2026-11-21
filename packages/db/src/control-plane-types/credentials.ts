import type { CredentialGrant, CredentialRight, CredentialTarget, Subject } from "../access.js";
import type { CredentialHolder } from "../access-holders.js";
import type { ProjectRef } from "../project-ref.js";

export interface CredentialPlace {
  readonly environment: string;
  readonly projectId: string;
}

export type CredentialState = "bound" | "missing" | "unbound";

export interface StoredCredential extends CredentialTarget {
  readonly name: string;
}

export interface CredentialShare {
  readonly shareId: string;
  readonly credential: Omit<StoredCredential, "projectId">;
  readonly project: ProjectRef;
  readonly credentialProject: ProjectRef;
  readonly offeredBy: string | null;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
  readonly createdAt: string;
}

export interface CredentialAccess {
  readonly credential: StoredCredential;
  readonly grants: readonly CredentialGrant[];
  readonly shares: readonly CredentialShare[];
}

export interface SharedCredential {
  readonly credential: StoredCredential;
  readonly shares: readonly CredentialShare[];
}

export interface CredentialAccessView {
  readonly credential: StoredCredential;
  readonly right: CredentialRight;
  readonly holders: readonly CredentialHolder[];
  readonly grants: readonly CredentialGrant[];
  readonly shares: readonly CredentialShare[];
  readonly serviceAccounts: readonly { readonly id: string; readonly name: string }[];
}

export interface DeploymentCredential {
  readonly credential: StoredCredential;
  readonly shareId: string | null;
}

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

export type DeclaredConnectionStatus = ConnectionStatus | Exclude<CredentialState, "bound">;

export interface ConnectionCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly provider: string;
  readonly providerConfig: Record<string, unknown> | null;
}

export interface StoredConnection {
  readonly accessTokenExpiresAt: string | null;
  readonly authorizationPending: boolean;
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

export interface ConnectionTokenPayload {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string | null;
  readonly obtainedAt: string;
  readonly refreshToken: string | null;
  readonly tokenType: string;
}

export interface BeginConnectionAuthorizationInput extends CredentialPlace {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly codeVerifier: string;
  readonly creator?: Subject;
  readonly expiresAt: string;
  readonly name: string;
  readonly provider: string;
  readonly providerConfig?: Record<string, unknown> | null;
  readonly reauthorizes: string | null;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly stateHash: string;
}

export interface ConsumedConnectionAuthorization {
  readonly clientId: string;
  readonly connectionId: string;
  readonly clientSecret: string;
  readonly codeVerifier: string;
  readonly existingRefreshToken: string | null;
  readonly provider: string;
  readonly providerConfig: Record<string, unknown> | null;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
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
  readonly preserveActive?: boolean;
}

export type ConnectionRefreshOutcome =
  | { readonly ok: true; readonly payload: ConnectionTokenPayload }
  | { readonly ok: false; readonly permanent: boolean; readonly errorCode: string };

export interface ResolveConnectionTokenInput {
  readonly connectionId: string;
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
  readonly credentials: ConnectionCredentials | null;
  readonly payload: ConnectionTokenPayload | null;
}

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
  readonly creator?: Subject;
  readonly name: string;
  readonly value: string;
  readonly replaces?: string | null;
}

export interface RecordRunExecutionSecretUsagesInput {
  readonly executionNumber: number;
  readonly injectedAt?: string;
  readonly runId: string;
  readonly secretUsages: readonly ResolvedSecret[];
}

export interface SecretView extends StoredSecret {
  readonly project: ProjectRef;
}
export interface ConnectionView extends StoredConnection {
  readonly project: ProjectRef;
}
