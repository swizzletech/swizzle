import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { credentialChanged } from "./control-plane-errors.js";
import { mapConnectionRow } from "./control-plane-read-models.js";
import type {
  BeginConnectionAuthorizationInput,
  ConnectionCredentials,
  ConnectionTokenPayload,
  ConnectionView,
  ConsumedConnectionAuthorization,
  CredentialPlace,
  DeleteConnectionResult,
  MarkConnectionErrorInput,
  RecordRunExecutionConnectionUsagesInput,
  ResolveConnectionTokenInput,
  ResolveConnectionTokenResult,
  StoreConnectionTokensInput,
  StoredConnection,
} from "./control-plane-types.js";
import { subjectValues } from "./grant-subject.js";
import { projectRefColumns } from "./project-ref-columns.js";
import {
  credentialGrants,
  environmentConnections,
  projects,
  runExecutionConnectionUsages,
} from "./schema.js";
import { decryptSecretValue, encryptSecretValue, SECRET_ENCRYPTION_ALGORITHM } from "./secrets.js";

const CONNECTION_PROJECTION = {
  accessTokenExpiresAt: environmentConnections.accessTokenExpiresAt,
  id: environmentConnections.id,
  projectId: environmentConnections.projectId,
  clientId: environmentConnections.clientId,
  createdAt: environmentConnections.createdAt,
  environment: environmentConnections.environment,
  lastErrorAt: environmentConnections.lastErrorAt,
  lastErrorCode: environmentConnections.lastErrorCode,
  lastRefreshedAt: environmentConnections.lastRefreshedAt,
  name: environmentConnections.name,
  pendingExpiresAt: environmentConnections.pendingExpiresAt,
  provider: environmentConnections.provider,
  providerConfig: environmentConnections.providerConfig,
  scopes: environmentConnections.scopes,
  status: environmentConnections.status,
  tokenVersion: environmentConnections.tokenVersion,
  updatedAt: environmentConnections.updatedAt,
} as const;

function connectionNamed(name: string, place: CredentialPlace) {
  return and(
    eq(environmentConnections.projectId, place.projectId),
    eq(environmentConnections.environment, place.environment),
    eq(environmentConnections.name, name),
  );
}

function decryptTokenPayload(row: {
  readonly tokenAlgorithm: string | null;
  readonly tokenCiphertext: string | null;
}): ConnectionTokenPayload | null {
  if (row.tokenCiphertext === null || row.tokenAlgorithm === null) {
    return null;
  }
  return JSON.parse(
    decryptSecretValue({ algorithm: row.tokenAlgorithm, ciphertext: row.tokenCiphertext }),
  ) as ConnectionTokenPayload;
}

export async function getConnection(
  client: DatabaseClient,
  name: string,
  place: CredentialPlace,
): Promise<ConnectionView | null> {
  const [row] = await client.db
    .select({
      ...CONNECTION_PROJECTION,
      project: projectRefColumns(projects),
    })
    .from(environmentConnections)
    .innerJoin(projects, eq(environmentConnections.projectId, projects.id))
    .where(connectionNamed(name, place))
    .limit(1);

  return row ? { ...mapConnectionRow(row), project: row.project } : null;
}

/**
 * Load a connection's decrypted OAuth client credentials. Used to build the
 * authorization URL, exchange the code, refresh tokens, and best-effort revoke.
 * Never surfaced to automation code.
 */
export async function getConnectionCredentials(
  client: DatabaseClient,
  name: string,
  place: CredentialPlace,
): Promise<ConnectionCredentials | null> {
  const [row] = await client.db
    .select({
      clientId: environmentConnections.clientId,
      clientSecretAlgorithm: environmentConnections.clientSecretAlgorithm,
      clientSecretCiphertext: environmentConnections.clientSecretCiphertext,
      provider: environmentConnections.provider,
      providerConfig: environmentConnections.providerConfig,
    })
    .from(environmentConnections)
    .where(connectionNamed(name, place))
    .limit(1);

  return row ? decryptCredentials(row) : null;
}

function decryptCredentials(row: {
  readonly clientId: string;
  readonly clientSecretAlgorithm: string;
  readonly clientSecretCiphertext: string;
  readonly provider: string;
  readonly providerConfig: unknown;
}): ConnectionCredentials {
  return {
    clientId: row.clientId,
    clientSecret: decryptSecretValue({
      algorithm: row.clientSecretAlgorithm,
      ciphertext: row.clientSecretCiphertext,
    }),
    provider: row.provider,
    providerConfig: (row.providerConfig as Record<string, unknown> | null) ?? null,
  };
}

export async function listConnections(
  client: DatabaseClient,
  environment: string,
  projectIds: readonly string[] | "all",
): Promise<readonly ConnectionView[]> {
  const rows = await client.db
    .select({
      ...CONNECTION_PROJECTION,
      project: projectRefColumns(projects),
    })
    .from(environmentConnections)
    .innerJoin(projects, eq(environmentConnections.projectId, projects.id))
    .where(
      and(
        eq(environmentConnections.environment, environment),
        projectIds === "all"
          ? undefined
          : inArray(environmentConnections.projectId, [...projectIds]),
      ),
    )
    .orderBy(asc(environmentConnections.name), asc(environmentConnections.projectId));

  return rows.map((row) => ({ ...mapConnectionRow(row), project: row.project }));
}

export async function beginConnectionAuthorization(
  client: DatabaseClient,
  input: BeginConnectionAuthorizationInput,
): Promise<ConnectionView> {
  const codeVerifierEnvelope = encryptSecretValue(input.codeVerifier);
  const clientSecretEnvelope = encryptSecretValue(input.clientSecret);
  const now = new Date();
  const pendingExpiresAt = new Date(input.expiresAt);

  await client.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: environmentConnections.id })
      .from(environmentConnections)
      .where(connectionNamed(input.name, input))
      .limit(1)
      .for("update");

    if ((existing?.id ?? null) !== input.reauthorizes) {
      throw credentialChanged("connection", input.name);
    }
    if (existing) {
      await tx
        .update(environmentConnections)
        .set({
          clientId: input.clientId,
          clientSecretAlgorithm: clientSecretEnvelope.algorithm,
          clientSecretCiphertext: clientSecretEnvelope.ciphertext,
          clientSecretKeyVersion: clientSecretEnvelope.keyVersion,
          pendingCodeVerifierCiphertext: codeVerifierEnvelope.ciphertext,
          pendingExpiresAt,
          pendingRedirectUri: input.redirectUri,
          pendingScopes: [...input.scopes],
          pendingStateHash: input.stateHash,
          provider: input.provider,
          providerConfig: input.providerConfig ?? null,
          updatedAt: now,
        })
        .where(eq(environmentConnections.id, existing.id));
      return;
    }

    const [inserted] = await tx
      .insert(environmentConnections)
      .values({
        clientId: input.clientId,
        clientSecretAlgorithm: clientSecretEnvelope.algorithm,
        clientSecretCiphertext: clientSecretEnvelope.ciphertext,
        clientSecretKeyVersion: clientSecretEnvelope.keyVersion,
        createdAt: now,
        environment: input.environment,
        name: input.name,
        projectId: input.projectId,
        pendingCodeVerifierCiphertext: codeVerifierEnvelope.ciphertext,
        pendingExpiresAt,
        pendingRedirectUri: input.redirectUri,
        pendingScopes: [...input.scopes],
        pendingStateHash: input.stateHash,
        provider: input.provider,
        providerConfig: input.providerConfig ?? null,
        scopes: [...input.scopes],
        status: "pending",
        updatedAt: now,
      })
      // A concurrent authorization that inserted the name first wins; this one was checked
      // against a connection that did not exist.
      .onConflictDoNothing({
        target: [
          environmentConnections.projectId,
          environmentConnections.environment,
          environmentConnections.name,
        ],
      })
      .returning({ id: environmentConnections.id });
    if (inserted === undefined) throw credentialChanged("connection", input.name);
    if (input.creator !== undefined) {
      await tx.insert(credentialGrants).values({
        connectionId: inserted.id,
        ...subjectValues(input.creator),
        role: "manage",
      });
    }
  });

  const persisted = await getConnection(client, input.name, input);
  if (persisted === null) {
    throw new Error(
      `Persisted connection could not be reloaded: ${input.environment}/${input.name}`,
    );
  }
  return persisted;
}

export async function consumeConnectionAuthorization(
  client: DatabaseClient,
  stateHash: string,
): Promise<ConsumedConnectionAuthorization | null> {
  return client.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        clientId: environmentConnections.clientId,
        clientSecretAlgorithm: environmentConnections.clientSecretAlgorithm,
        clientSecretCiphertext: environmentConnections.clientSecretCiphertext,
        id: environmentConnections.id,
        pendingCodeVerifierCiphertext: environmentConnections.pendingCodeVerifierCiphertext,
        pendingExpiresAt: environmentConnections.pendingExpiresAt,
        pendingRedirectUri: environmentConnections.pendingRedirectUri,
        pendingScopes: environmentConnections.pendingScopes,
        provider: environmentConnections.provider,
        providerConfig: environmentConnections.providerConfig,
        status: environmentConnections.status,
        tokenAlgorithm: environmentConnections.tokenAlgorithm,
        tokenCiphertext: environmentConnections.tokenCiphertext,
      })
      .from(environmentConnections)
      .where(eq(environmentConnections.pendingStateHash, stateHash))
      .limit(1)
      .for("update");

    if (!row) {
      return null;
    }

    // Single-use: the pending authorization is consumed no matter what the
    // caller does with it afterwards. A replayed state finds nothing.
    await tx
      .update(environmentConnections)
      .set({
        pendingCodeVerifierCiphertext: null,
        pendingExpiresAt: null,
        pendingRedirectUri: null,
        pendingScopes: null,
        pendingStateHash: null,
        updatedAt: new Date(),
      })
      .where(eq(environmentConnections.id, row.id));

    if (
      row.pendingExpiresAt === null ||
      row.pendingExpiresAt.getTime() < Date.now() ||
      row.pendingCodeVerifierCiphertext === null ||
      row.pendingRedirectUri === null
    ) {
      return null;
    }

    const existingPayload = decryptTokenPayload(row);

    return {
      clientId: row.clientId,
      connectionId: row.id,
      clientSecret: decryptSecretValue({
        algorithm: row.clientSecretAlgorithm,
        ciphertext: row.clientSecretCiphertext,
      }),
      codeVerifier: decryptSecretValue({
        algorithm: SECRET_ENCRYPTION_ALGORITHM,
        ciphertext: row.pendingCodeVerifierCiphertext,
      }),
      existingRefreshToken: existingPayload?.refreshToken ?? null,
      provider: row.provider,
      providerConfig: (row.providerConfig as Record<string, unknown> | null) ?? null,
      redirectUri: row.pendingRedirectUri,
      scopes: Array.isArray(row.pendingScopes) ? (row.pendingScopes as string[]) : [],
      wasActive: row.status === "active",
    } satisfies ConsumedConnectionAuthorization;
  });
}

export async function storeConnectionTokens(
  client: DatabaseClient,
  input: StoreConnectionTokensInput,
): Promise<StoredConnection | null> {
  const envelope = encryptSecretValue(JSON.stringify(input.payload));
  const now = new Date();
  const [row] = await client.db
    .update(environmentConnections)
    .set({
      accessTokenExpiresAt: input.payload.accessTokenExpiresAt
        ? new Date(input.payload.accessTokenExpiresAt)
        : null,
      lastErrorAt: null,
      lastErrorCode: null,
      lastRefreshedAt: now,
      status: "active",
      tokenAlgorithm: envelope.algorithm,
      tokenCiphertext: envelope.ciphertext,
      tokenKeyVersion: envelope.keyVersion,
      tokenVersion: sql`${environmentConnections.tokenVersion} + 1`,
      updatedAt: now,
      ...(input.scopes ? { scopes: [...input.scopes] } : {}),
    })
    .where(eq(environmentConnections.id, input.connectionId))
    .returning(CONNECTION_PROJECTION);
  return row ? mapConnectionRow(row) : null;
}

export async function markConnectionError(
  client: DatabaseClient,
  input: MarkConnectionErrorInput,
): Promise<StoredConnection | null> {
  const now = new Date();
  // An abandoned reconnect keeps an active connection active.
  const status =
    input.preserveActive === true
      ? sql`CASE WHEN ${environmentConnections.status} = 'active' THEN 'active' ELSE 'error' END`
      : "error";
  const [row] = await client.db
    .update(environmentConnections)
    .set({ lastErrorAt: now, lastErrorCode: input.errorCode, status, updatedAt: now })
    .where(eq(environmentConnections.id, input.connectionId))
    .returning(CONNECTION_PROJECTION);
  return row ? mapConnectionRow(row) : null;
}

export async function resolveConnectionToken(
  client: DatabaseClient,
  input: ResolveConnectionTokenInput,
): Promise<ResolveConnectionTokenResult> {
  const fastPath = await loadResolvableConnection(client, input.connectionId);
  if (fastPath.result) {
    return fastPath.result;
  }
  if (
    fastPath.connection &&
    fastPath.payload &&
    !needsRefresh(fastPath.connection, input.refreshSkewMs)
  ) {
    return {
      accessToken: fastPath.payload.accessToken,
      accessTokenExpiresAt: fastPath.payload.accessTokenExpiresAt,
      connection: fastPath.connection,
      outcome: "resolved",
      refreshed: false,
    };
  }

  // Slow path: serialize concurrent refreshers on the row so exactly one
  // worker talks to the provider while the others wait and re-read.
  return client.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        ...CONNECTION_PROJECTION,
        id: environmentConnections.id,
        tokenAlgorithm: environmentConnections.tokenAlgorithm,
        tokenCiphertext: environmentConnections.tokenCiphertext,
      })
      .from(environmentConnections)
      .where(eq(environmentConnections.id, input.connectionId))
      .limit(1)
      .for("update");

    if (!row) {
      return { outcome: "missing" } satisfies ResolveConnectionTokenResult;
    }

    const connection = mapConnectionRow(row);
    if (connection.status !== "active") {
      return { connection, outcome: "inactive" } satisfies ResolveConnectionTokenResult;
    }

    const payload = decryptTokenPayload(row);
    if (payload === null) {
      return { connection, outcome: "inactive" } satisfies ResolveConnectionTokenResult;
    }

    // Another worker may have refreshed while we waited on the lock.
    if (!needsRefresh(connection, input.refreshSkewMs)) {
      return {
        accessToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        connection,
        outcome: "resolved",
        refreshed: false,
      } satisfies ResolveConnectionTokenResult;
    }

    const refreshOutcome = await input.refresh(connection, payload);
    const now = new Date();

    if (!refreshOutcome.ok) {
      await tx
        .update(environmentConnections)
        .set({
          lastErrorAt: now,
          lastErrorCode: refreshOutcome.errorCode,
          updatedAt: now,
          ...(refreshOutcome.permanent ? { status: "error" } : {}),
        })
        .where(eq(environmentConnections.id, row.id));
      return {
        connection,
        errorCode: refreshOutcome.errorCode,
        outcome: "refresh-failed",
        permanent: refreshOutcome.permanent,
      } satisfies ResolveConnectionTokenResult;
    }

    const envelope = encryptSecretValue(JSON.stringify(refreshOutcome.payload));
    const nextTokenVersion = connection.tokenVersion + 1;
    await tx
      .update(environmentConnections)
      .set({
        accessTokenExpiresAt: refreshOutcome.payload.accessTokenExpiresAt
          ? new Date(refreshOutcome.payload.accessTokenExpiresAt)
          : null,
        lastErrorAt: null,
        lastErrorCode: null,
        lastRefreshedAt: now,
        tokenAlgorithm: envelope.algorithm,
        tokenCiphertext: envelope.ciphertext,
        tokenKeyVersion: envelope.keyVersion,
        tokenVersion: nextTokenVersion,
        updatedAt: now,
      })
      .where(eq(environmentConnections.id, row.id));

    return {
      accessToken: refreshOutcome.payload.accessToken,
      accessTokenExpiresAt: refreshOutcome.payload.accessTokenExpiresAt,
      connection: { ...connection, tokenVersion: nextTokenVersion },
      outcome: "resolved",
      refreshed: true,
    } satisfies ResolveConnectionTokenResult;
  });
}

async function loadResolvableConnection(
  client: DatabaseClient,
  connectionId: string,
): Promise<{
  connection?: StoredConnection;
  payload?: ConnectionTokenPayload;
  result?: ResolveConnectionTokenResult;
}> {
  const [row] = await client.db
    .select({
      ...CONNECTION_PROJECTION,
      tokenAlgorithm: environmentConnections.tokenAlgorithm,
      tokenCiphertext: environmentConnections.tokenCiphertext,
    })
    .from(environmentConnections)
    .where(eq(environmentConnections.id, connectionId))
    .limit(1);

  if (!row) {
    return { result: { outcome: "missing" } };
  }
  const connection = mapConnectionRow(row);
  if (connection.status !== "active") {
    return { result: { connection, outcome: "inactive" } };
  }
  const payload = decryptTokenPayload(row);
  if (payload === null) {
    return { result: { connection, outcome: "inactive" } };
  }
  return { connection, payload };
}

function needsRefresh(connection: StoredConnection, refreshSkewMs: number): boolean {
  if (connection.accessTokenExpiresAt === null) {
    return false;
  }
  return new Date(connection.accessTokenExpiresAt).getTime() <= Date.now() + refreshSkewMs;
}

export async function deleteConnection(
  client: DatabaseClient,
  connectionId: string,
): Promise<DeleteConnectionResult> {
  const [deleted] = await deleteConnectionsWhere(
    client.db,
    eq(environmentConnections.id, connectionId),
  );
  return deleted ?? { credentials: null, deleted: false, payload: null };
}

/**
 * Deletes the connections `where` matches, in `db` or a transaction, and decrypts what the
 * caller needs to revoke each one at its provider.
 */
export async function deleteConnectionsWhere(
  db: Pick<DatabaseClient["db"], "delete">,
  where: SQL,
): Promise<readonly DeleteConnectionResult[]> {
  const rows = await db.delete(environmentConnections).where(where).returning({
    clientId: environmentConnections.clientId,
    clientSecretAlgorithm: environmentConnections.clientSecretAlgorithm,
    clientSecretCiphertext: environmentConnections.clientSecretCiphertext,
    provider: environmentConnections.provider,
    providerConfig: environmentConnections.providerConfig,
    tokenAlgorithm: environmentConnections.tokenAlgorithm,
    tokenCiphertext: environmentConnections.tokenCiphertext,
  });
  return rows.map((deleted) => {
    // Undecryptable material must not block deletion; it only skips the provider revocation.
    try {
      return {
        credentials: decryptCredentials(deleted),
        deleted: true,
        payload: decryptTokenPayload(deleted),
      };
    } catch {
      return { credentials: null, deleted: true, payload: null };
    }
  });
}

export async function recordRunExecutionConnectionUsages(
  client: DatabaseClient,
  input: RecordRunExecutionConnectionUsagesInput,
): Promise<void> {
  if (input.connectionUsages.length === 0) {
    return;
  }

  const injectedAt = new Date(input.injectedAt ?? new Date().toISOString());
  await client.db.insert(runExecutionConnectionUsages).values(
    input.connectionUsages.map((connectionUsage) => ({
      executionNumber: input.executionNumber,
      connectionName: connectionUsage.connectionName,
      environment: connectionUsage.environment,
      injectedAt,
      provider: connectionUsage.provider,
      runId: input.runId,
      tokenVersion: connectionUsage.tokenVersion,
    })),
  );
}
