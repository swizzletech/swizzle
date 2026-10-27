import { createHash, randomBytes } from "node:crypto";
import { AUTOMATION_CONNECTION_NAME_PATTERN } from "@swizzle/config";
import {
  CONNECTION_PROVIDER_IDS,
  type ConnectionProviderAdapter,
  ConnectionProviderError,
  type ConnectionTokenSet,
  getConnectionProviderAdapter,
  isConnectionProviderId,
} from "@swizzle/connections";
import {
  type BeginConnectionAuthorizationInput,
  CodedError,
  type ConnectionCredentials,
  type ConnectionRefreshOutcome,
  type ConnectionTokenPayload,
  type ConnectionView,
  type ControlPlaneStore,
  type CredentialPlace,
  type DeleteConnectionResult,
  type StoredConnection,
  type StoredCredential,
  type StoredDeployment,
  type StoredTrigger,
  type Subject,
} from "@swizzle/db";

import {
  boundCredentialsNamed,
  type CredentialHolder,
  credentialStates,
} from "./deployment-credentials.js";
import { AutomationRuntimeError } from "./errors.js";
import type {
  BeginConnectionAuthorizationResult,
  PlatformConnectionStatusRecord,
} from "./platform-records.js";

const CONNECTION_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const CONNECTION_REFRESH_SKEW_MS = 120 * 1000;
export const CONNECTION_ENV_PREFIX = "SWIZZLE_CONNECTION_";

export type PlatformConnectionRecord = ConnectionView;

export interface ResolvedConnectionToken {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string | null;
  readonly environment: string;
  readonly name: string;
  readonly provider: string;
  readonly tokenVersion: number;
}

export type ConnectionCallbackResult =
  | { readonly ok: true; readonly connection: StoredConnection }
  | { readonly ok: false; readonly errorCode: string };

export function connectionEnvVarName(connectionName: string): string {
  return `${CONNECTION_ENV_PREFIX}${connectionName.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`;
}

function assertConnectionNameIsValid(name: string): void {
  if (!AUTOMATION_CONNECTION_NAME_PATTERN.test(name)) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      `Connection names must be lowercase kebab-case (max 60 characters): ${name}`,
    );
  }
}

/**
 * Load a connection's decrypted OAuth client credentials from the store. The
 * client id/secret and provider config live on the connection itself; they are
 * used to build the authorization URL and to exchange/refresh/revoke tokens.
 */
async function loadConnectionCredentials(options: {
  readonly name: string;
  readonly place: CredentialPlace;
  readonly store: ControlPlaneStore;
}): Promise<ConnectionCredentials> {
  const credentials = await options.store.getConnectionCredentials(options.name, options.place);
  if (credentials === null) {
    throw new AutomationRuntimeError(
      "CONNECTION_CLIENT_CREDENTIALS_MISSING",
      `Connection "${options.name}" has no client credentials in environment ${options.place.environment}. Provide them with: swizzle connections authorize ${options.name} --provider <provider> --client-id <id> --client-secret-env <VAR>`,
      {
        details: {
          connection: options.name,
          environment: options.place.environment,
        },
      },
    );
  }
  return credentials;
}

function getAdapterOrThrow(provider: string, providerConfig: unknown): ConnectionProviderAdapter {
  if (!isConnectionProviderId(provider)) {
    throw new AutomationRuntimeError(
      "CONNECTION_PROVIDER_UNKNOWN",
      `Unknown connection provider: ${provider}. Supported providers: ${CONNECTION_PROVIDER_IDS.join(", ")}.`,
    );
  }
  try {
    return getConnectionProviderAdapter(provider, providerConfig ?? undefined);
  } catch (error) {
    if (error instanceof ConnectionProviderError) {
      throw new AutomationRuntimeError("CONNECTION_PROVIDER_UNKNOWN", error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function tokenSetToPayload(
  tokens: ConnectionTokenSet,
  previousRefreshToken: string | null,
): ConnectionTokenPayload {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt?.toISOString() ?? null,
    obtainedAt: new Date().toISOString(),
    // Some providers (Google on re-consent) omit the refresh token; keep the
    // previous one so the connection stays refreshable.
    refreshToken: tokens.refreshToken ?? previousRefreshToken,
    tokenType: tokens.tokenType,
  };
}

function resolveEffectiveScopes(
  requestedScopes: readonly string[],
  existing: StoredConnection | undefined,
): readonly string[] {
  if (requestedScopes.length > 0) {
    return [...requestedScopes];
  }
  if (existing !== undefined && existing.scopes.length > 0) {
    return [...existing.scopes];
  }
  return [];
}

function assertScopesArePresentIfRequired(options: {
  readonly adapter: ConnectionProviderAdapter;
  readonly connectionName: string;
  readonly scopes: readonly string[];
}): void {
  if (!options.adapter.requiresScopes || options.scopes.length > 0) {
    return;
  }
  throw new AutomationRuntimeError(
    "CONNECTION_SCOPES_REQUIRED",
    `Connection "${options.connectionName}" requires OAuth scopes; no scopes provided and none stored on connection ${options.connectionName}; pass --scopes <comma-separated>.`,
    {
      details: {
        connection: options.connectionName,
        provider: options.adapter.id,
      },
    },
  );
}

export async function beginPlatformConnectionAuthorization(options: {
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  /** Whoever creates the connection, a person or a service account, gets a manage grant on it. */
  readonly creator?: Subject | undefined;
  readonly name: string;
  readonly place: CredentialPlace;
  readonly provider?: string | undefined;
  readonly providerConfig?: Record<string, unknown> | null | undefined;
  /** See {@link BeginConnectionAuthorizationInput.reauthorizes}. */
  readonly reauthorizes: string | null;
  /** Copy client credentials from an existing connection instead of re-entering them. */
  readonly reuseFrom?: string | undefined;
  readonly publicUrl: string;
  readonly scopes: readonly string[];
  readonly store: ControlPlaneStore;
}): Promise<BeginConnectionAuthorizationResult> {
  assertConnectionNameIsValid(options.name);

  const existingConnections = await options.store.listConnections(options.place.environment, [
    options.place.projectId,
  ]);
  const envVarName = connectionEnvVarName(options.name);
  const collision = existingConnections.find(
    (connection) =>
      connection.name !== options.name && connectionEnvVarName(connection.name) === envVarName,
  );
  if (collision) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      `Connection name "${options.name}" would collide with "${collision.name}" after env var sanitization (${envVarName}).`,
    );
  }

  const existing = existingConnections.find((connection) => connection.name === options.name);
  const credentials = await resolveEffectiveCredentials(options, existing);
  const adapter = getAdapterOrThrow(credentials.provider, credentials.providerConfig);
  const effectiveScopes = resolveEffectiveScopes(options.scopes, existing);
  assertScopesArePresentIfRequired({
    adapter,
    connectionName: options.name,
    scopes: effectiveScopes,
  });

  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const redirectUri = buildConnectionRedirectUri(options.publicUrl, credentials.provider);
  const expiresAt = new Date(Date.now() + CONNECTION_AUTHORIZATION_TTL_MS).toISOString();

  const authorizationUrl = adapter.createAuthorizationUrl({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    codeVerifier,
    // Force consent whenever we do not hold a refresh token yet, so the
    // provider issues one (Google only does this on the consent screen).
    forceConsent: existing?.status !== "active",
    redirectUri,
    scopes: effectiveScopes,
    state,
  });

  const connection = await options.store
    .beginConnectionAuthorization({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      codeVerifier,
      ...(options.creator !== undefined ? { creator: options.creator } : {}),
      environment: options.place.environment,
      expiresAt,
      name: options.name,
      projectId: options.place.projectId,
      provider: credentials.provider,
      providerConfig: credentials.providerConfig,
      reauthorizes: options.reauthorizes,
      redirectUri,
      scopes: effectiveScopes,
      stateHash: hashState(state),
    })
    .catch((error: unknown) => {
      if (error instanceof CodedError && error.code === "CREDENTIAL_CHANGED") {
        throw new AutomationRuntimeError(error.code, error.message, {
          cause: error,
          ...(error.details !== undefined ? { details: error.details } : {}),
        });
      }
      throw error;
    });

  return {
    authorizationUrl: authorizationUrl.toString(),
    connection,
    expiresAt,
    redirectUri,
  };
}

/**
 * Resolve which client credentials to use for an authorization: freshly entered
 * client id/secret, copied from another connection (`reuseFrom`), or the ones
 * already stored on the connection when re-authorizing (reconnect).
 */
async function resolveEffectiveCredentials(
  options: {
    readonly clientId?: string | undefined;
    readonly clientSecret?: string | undefined;
    readonly name: string;
    readonly place: CredentialPlace;
    readonly provider?: string | undefined;
    readonly providerConfig?: Record<string, unknown> | null | undefined;
    readonly reuseFrom?: string | undefined;
    readonly store: ControlPlaneStore;
  },
  existing: StoredConnection | undefined,
): Promise<ConnectionCredentials> {
  if (options.reuseFrom !== undefined && options.reuseFrom !== "") {
    if (options.reuseFrom === options.name) {
      throw new AutomationRuntimeError(
        "AUTOMATION_CONFIG_INVALID",
        "A connection cannot reuse its own credentials.",
      );
    }
    const source = await options.store.getConnectionCredentials(options.reuseFrom, options.place);
    if (source === null) {
      throw new AutomationRuntimeError(
        "CONNECTION_CLIENT_CREDENTIALS_MISSING",
        `Cannot reuse credentials from connection "${options.reuseFrom}": it does not exist in this project's environment ${options.place.environment}.`,
      );
    }
    return source;
  }

  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (clientId !== "" && clientSecret !== "") {
    const provider = options.provider ?? existing?.provider;
    if (provider === undefined || provider === "") {
      throw new AutomationRuntimeError(
        "CONNECTION_PROVIDER_UNKNOWN",
        "A provider is required when creating a connection with new client credentials.",
      );
    }
    return {
      clientId,
      clientSecret,
      provider,
      providerConfig: options.providerConfig ?? existing?.providerConfig ?? null,
    };
  }

  if (clientId !== "" || clientSecret !== "") {
    throw new AutomationRuntimeError(
      "CONNECTION_CLIENT_CREDENTIALS_MISSING",
      `Both client id and client secret are required to set credentials for connection "${options.name}".`,
    );
  }

  // No new credentials supplied: reconnect using the ones already stored.
  return loadConnectionCredentials({
    name: options.name,
    place: options.place,
    store: options.store,
  });
}

export function buildConnectionRedirectUri(publicUrl: string, provider: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}/oauth/callback/${provider}`;
}

export async function completePlatformConnectionCallback(options: {
  readonly code?: string | undefined;
  readonly providerFromPath: string;
  readonly providerError?: string | undefined;
  readonly state?: string | undefined;
  readonly store: ControlPlaneStore;
}): Promise<ConnectionCallbackResult> {
  if (options.state === undefined || options.state === "") {
    return { errorCode: "CONNECTION_STATE_INVALID", ok: false };
  }

  const consumed = await options.store.consumeConnectionAuthorization(hashState(options.state));
  if (consumed === null) {
    return { errorCode: "CONNECTION_STATE_INVALID", ok: false };
  }

  const markError = async (errorCode: string): Promise<ConnectionCallbackResult> => {
    await options.store.markConnectionError({
      connectionId: consumed.connectionId,
      errorCode,
      preserveActive: consumed.wasActive,
    });
    return { errorCode, ok: false };
  };

  if (consumed.provider !== options.providerFromPath) {
    return await markError("CONNECTION_STATE_INVALID");
  }

  if (options.providerError !== undefined && options.providerError !== "") {
    const errorCode =
      options.providerError === "access_denied"
        ? "PROVIDER_ACCESS_DENIED"
        : "PROVIDER_AUTHORIZATION_FAILED";
    return await markError(errorCode);
  }

  if (options.code === undefined || options.code === "") {
    return await markError("PROVIDER_AUTHORIZATION_FAILED");
  }

  let adapter: ConnectionProviderAdapter;
  try {
    adapter = getAdapterOrThrow(consumed.provider, consumed.providerConfig);
  } catch {
    return await markError("CONNECTION_PROVIDER_UNKNOWN");
  }

  try {
    const tokens = await adapter.exchangeAuthorizationCode({
      clientId: consumed.clientId,
      clientSecret: consumed.clientSecret,
      code: options.code,
      codeVerifier: consumed.codeVerifier,
      redirectUri: consumed.redirectUri,
    });

    // The tokens belong to the connection the authorization began on. If that one was deleted
    // meanwhile, a connection of the same name is another credential and gets nothing.
    const connection = await options.store.storeConnectionTokens({
      connectionId: consumed.connectionId,
      payload: tokenSetToPayload(tokens, consumed.existingRefreshToken),
      scopes: consumed.scopes,
    });
    if (connection === null) {
      return { errorCode: "CONNECTION_STATE_INVALID", ok: false };
    }
    return { connection, ok: true };
  } catch (error) {
    const errorCode =
      error instanceof ConnectionProviderError && error.kind !== "transient"
        ? "PROVIDER_CODE_EXCHANGE_REJECTED"
        : "PROVIDER_CODE_EXCHANGE_FAILED";
    return await markError(errorCode);
  }
}

export async function listPlatformConnections(options: {
  readonly environment: string;
  readonly projectIds: readonly string[] | "all";
  readonly store: ControlPlaneStore;
}): Promise<readonly PlatformConnectionRecord[]> {
  return await options.store.listConnections(options.environment, options.projectIds);
}

export async function getPlatformConnection(options: {
  readonly name: string;
  readonly place: CredentialPlace;
  readonly store: ControlPlaneStore;
}): Promise<PlatformConnectionRecord | null> {
  return await options.store.getConnection(options.name, options.place);
}

export async function deletePlatformConnection(options: {
  readonly connectionId: string;
  readonly store: ControlPlaneStore;
}): Promise<boolean> {
  const result = await options.store.deleteConnection(options.connectionId);
  if (!result.deleted) {
    return false;
  }
  await revokeDeletedConnection(result);
  return true;
}

/** Best-effort provider-side revocation of a connection whose platform record is already gone. */
export async function revokeDeletedConnection(result: DeleteConnectionResult): Promise<void> {
  const { credentials } = result;
  if (!result.payload || !credentials) return;
  try {
    const adapter = getAdapterOrThrow(credentials.provider, credentials.providerConfig);
    if (adapter.revokeToken) {
      await adapter.revokeToken({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        token: result.payload.refreshToken ?? result.payload.accessToken,
      });
    }
  } catch {
    // Revocation failures must not resurrect the connection or fail the delete.
  }
}

function buildRefreshCallback(
  store: ControlPlaneStore,
): (
  connection: StoredConnection,
  payload: ConnectionTokenPayload,
) => Promise<ConnectionRefreshOutcome> {
  return async (connection, payload) => {
    if (payload.refreshToken === null) {
      return { errorCode: "CONNECTION_REFRESH_TOKEN_MISSING", ok: false, permanent: true };
    }

    let adapter: ConnectionProviderAdapter;
    let credentials: ConnectionCredentials;
    try {
      const loaded = await store.getConnectionCredentials(connection.name, connection);
      if (loaded === null) {
        return { errorCode: "CONNECTION_CLIENT_CREDENTIALS_MISSING", ok: false, permanent: true };
      }
      credentials = loaded;
      adapter = getAdapterOrThrow(credentials.provider, credentials.providerConfig);
    } catch {
      return { errorCode: "CONNECTION_CLIENT_CREDENTIALS_MISSING", ok: false, permanent: true };
    }

    try {
      const tokens = await adapter.refreshAccessToken({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        refreshToken: payload.refreshToken,
        scopes: connection.scopes,
      });
      return { ok: true, payload: tokenSetToPayload(tokens, payload.refreshToken) };
    } catch (error) {
      if (error instanceof ConnectionProviderError) {
        return {
          errorCode: error.providerErrorCode ?? error.kind.toUpperCase().replaceAll("-", "_"),
          ok: false,
          permanent: error.kind === "invalid-grant",
        };
      }
      return { errorCode: "PROVIDER_REFRESH_FAILED", ok: false, permanent: false };
    }
  };
}

/** The access token of a connection, refreshed when it expires within `refreshSkewMs`. */
export async function resolvePlatformConnectionToken(options: {
  readonly automationName?: string;
  readonly connection: Pick<StoredCredential, "environment" | "id" | "name">;
  readonly refreshSkewMs?: number;
  readonly store: ControlPlaneStore;
}): Promise<{ readonly refreshed: boolean; readonly token: ResolvedConnectionToken }> {
  const { environment, name } = options.connection;
  const result = await options.store.resolveConnectionToken({
    connectionId: options.connection.id,
    refresh: buildRefreshCallback(options.store),
    refreshSkewMs: options.refreshSkewMs ?? CONNECTION_REFRESH_SKEW_MS,
  });

  const context = options.automationName ? `Automation ${options.automationName}` : "Connection";

  switch (result.outcome) {
    case "missing":
      throw new AutomationRuntimeError(
        "PLATFORM_REQUIRED_CONNECTIONS_MISSING",
        `${context} requires connection "${name}" which does not exist in environment ${environment}. Create it with: swizzle connections authorize ${name} --provider <provider> --client-id <id> --client-secret-env <VAR>`,
        { details: { environment, missingConnections: [name] } },
      );
    case "inactive":
      throw new AutomationRuntimeError(
        "PLATFORM_REQUIRED_CONNECTIONS_MISSING",
        `${context} requires connection "${name}" in environment ${environment}, but it is ${result.connection.status}. Re-authorize it with: swizzle connections authorize ${name}`,
        {
          details: {
            environment,
            missingConnections: [name],
            status: result.connection.status,
          },
        },
      );
    case "refresh-failed":
      if (result.permanent) {
        throw new AutomationRuntimeError(
          "PLATFORM_CONNECTION_UNAUTHORIZED",
          `Connection "${name}" in environment ${environment} is no longer authorized (${result.errorCode}). Re-authorize it with: swizzle connections authorize ${name}. Note: Google OAuth clients in "Testing" publishing status expire refresh tokens after 7 days.`,
          {
            details: {
              connection: name,
              environment,
              errorCode: result.errorCode,
            },
          },
        );
      }
      throw new AutomationRuntimeError(
        "PLATFORM_CONNECTION_REFRESH_FAILED",
        `Token refresh for connection "${name}" in environment ${environment} failed transiently (${result.errorCode}). The run can be retried.`,
        {
          details: {
            connection: name,
            environment,
            errorCode: result.errorCode,
          },
        },
      );
    case "resolved":
      return {
        refreshed: result.refreshed,
        token: {
          accessToken: result.accessToken,
          accessTokenExpiresAt: result.accessTokenExpiresAt,
          environment: result.connection.environment,
          name: result.connection.name,
          provider: result.connection.provider,
          tokenVersion: result.connection.tokenVersion,
        },
      };
  }
}

/** The access token of each connection a deployment bound, as a run receives it. */
export async function resolveRequiredConnections(options: {
  readonly automationName: string;
  readonly connectionNames: readonly string[];
  readonly environment: string;
  readonly holder: CredentialHolder;
  readonly store: ControlPlaneStore;
}): Promise<readonly ResolvedConnectionToken[]> {
  const bound = await requireBoundConnections(options);
  const tokens: ResolvedConnectionToken[] = [];
  for (const connection of bound) {
    const resolved = await resolvePlatformConnectionToken({
      automationName: options.automationName,
      connection,
      store: options.store,
    });
    tokens.push(resolved.token);
  }
  return tokens;
}

export async function ensureDeploymentConnectionsPresent(options: {
  readonly deployment: StoredDeployment;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  await ensureBoundConnectionsUsable({
    automationName: options.deployment.automationName,
    connectionNames: options.deployment.config.connections,
    environment: options.deployment.environment,
    holder: options.deployment,
    store: options.store,
  });
}

export async function ensureTriggerConnectionsPresent(options: {
  readonly store: ControlPlaneStore;
  readonly trigger: StoredTrigger;
}): Promise<void> {
  await ensureBoundConnectionsUsable({
    automationName: options.trigger.automationName,
    connectionNames: options.trigger.config.connections,
    environment: options.trigger.environment,
    holder: options.trigger,
    store: options.store,
  });
}

export async function getDeploymentConnectionHealth(options: {
  readonly deployment: StoredDeployment;
  readonly store: ControlPlaneStore;
}): Promise<readonly PlatformConnectionStatusRecord[]> {
  const { deployment, store } = options;
  const states = await credentialStates({
    deployment,
    kind: "connection",
    names: deployment.config.connections,
    store,
  });
  const connectionsByName = await connectionRecords(
    store,
    deployment.environment,
    states.flatMap(({ credential }) => (credential === null ? [] : [credential])),
  );
  return states.map(({ name, state }) => {
    const connection = connectionsByName.get(name) ?? null;
    return {
      accessTokenExpiresAt: connection?.accessTokenExpiresAt ?? null,
      environment: deployment.environment,
      lastErrorCode: connection?.lastErrorCode ?? null,
      name,
      provider: connection?.provider ?? null,
      status: connection?.status ?? (state === "bound" ? "missing" : state),
    };
  });
}

async function requireBoundConnections(options: {
  readonly automationName: string;
  readonly connectionNames: readonly string[];
  readonly environment: string;
  readonly holder: CredentialHolder;
  readonly store: ControlPlaneStore;
}): Promise<readonly StoredCredential[]> {
  const { bound, missing } = await boundCredentialsNamed({
    holder: options.holder,
    kind: "connection",
    names: options.connectionNames,
    store: options.store,
  });
  if (missing.length > 0) {
    throw new AutomationRuntimeError(
      "PLATFORM_REQUIRED_CONNECTIONS_MISSING",
      `Automation ${options.automationName} has lost platform connections in environment ${options.environment}: ${missing.join(", ")}. Each was deleted, its share was revoked, or the automation moved away from it. Authorize them with: swizzle connections authorize <name>, then deploy again.`,
      { details: { environment: options.environment, missingConnections: missing } },
    );
  }
  return bound;
}

async function ensureBoundConnectionsUsable(options: {
  readonly automationName: string;
  readonly connectionNames: readonly string[];
  readonly environment: string;
  readonly holder: CredentialHolder;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  const bound = await requireBoundConnections(options);
  const connectionsByName = await connectionRecords(options.store, options.environment, bound);
  const unusable = options.connectionNames.filter(
    (name) => connectionsByName.get(name)?.status !== "active",
  );
  if (unusable.length > 0) {
    throw new AutomationRuntimeError(
      "PLATFORM_REQUIRED_CONNECTIONS_MISSING",
      `Automation ${options.automationName} requires active platform connections in environment ${options.environment}: ${unusable.join(", ")}. Authorize them with: swizzle connections authorize <name>`,
      { details: { environment: options.environment, missingConnections: unusable } },
    );
  }
}

/** The records of these bound connections, by name. */
async function connectionRecords(
  store: ControlPlaneStore,
  environment: string,
  bound: readonly StoredCredential[],
): Promise<ReadonlyMap<string, StoredConnection>> {
  const projectIds = [...new Set(bound.map((connection) => connection.projectId))];
  if (projectIds.length === 0) return new Map();
  const boundIds = new Set(bound.map((connection) => connection.id));
  const connections = await store.listConnections(environment, projectIds);
  return new Map(
    connections.flatMap((connection) =>
      boundIds.has(connection.id) ? [[connection.name, connection] as const] : [],
    ),
  );
}
