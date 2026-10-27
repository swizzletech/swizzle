import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { apiTokens, workerGrants, workers } from "./schema.js";

/** Registry and dispatch read expiry from the same current credential that the guard verifies. */
export function selectWorkerCredentials(db: DatabaseClient["db"]) {
  return db
    .select({
      ...getTableColumns(workers),
      environments: sql<import("./workers.js").WorkerEnvironment[]>`coalesce(
        (select jsonb_agg(jsonb_build_object('projectId', ${workerGrants.projectId}, 'environment', ${workerGrants.environment})
          order by ${workerGrants.projectId}, ${workerGrants.environment}) from ${workerGrants}
          where ${workerGrants.workerId} = ${workers.id}), '[]'::jsonb)`,
      tokenId: apiTokens.id,
      tokenExpiresAt: sql<Date | null>`coalesce(${apiTokens.expiresAt},
        (select expires_at from api_tokens
         where worker_id = ${workers.id} and ${workers.revokedAt} is not null
         order by created_at desc limit 1))`.mapWith(apiTokens.expiresAt),
    })
    .from(workers)
    .leftJoin(apiTokens, and(eq(apiTokens.workerId, workers.id), isNull(apiTokens.revokedAt)));
}

/** A worker row with its current credential's expiry, as `selectWorkerCredentials` reads it. */
interface CredentialState {
  readonly revokedAt: Date | null;
  readonly tokenExpiresAt: Date | null;
  readonly credentialGeneration: number;
}

/** The one rule for a live credential: the worker is not revoked and its token has not expired. */
export function credentialLive<Row extends CredentialState>(
  row: Row | undefined,
): row is Row & { readonly tokenExpiresAt: Date } {
  return (
    row !== undefined &&
    row.revokedAt === null &&
    row.tokenExpiresAt !== null &&
    row.tokenExpiresAt > new Date()
  );
}

/** Whether `identity` holds the worker's live credential, not one a renewal already replaced. */
export function holdsCredential<Row extends CredentialState>(
  row: Row | undefined,
  identity: { readonly credentialGeneration: number },
): row is Row & { readonly tokenExpiresAt: Date } {
  return credentialLive(row) && row.credentialGeneration === identity.credentialGeneration;
}
