import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, lte, or, type SQL } from "drizzle-orm";
import { PROJECT_ROLES, SERVICE_ACCOUNT_MAX_ROLE, type TokenScope } from "./access.js";
import type { PersonOnRecord } from "./access-store.js";
import { causeCode, createDatabaseClient, type DatabaseClient, PG_ERROR } from "./client.js";
import { CodedError } from "./coded-error.js";
import { apiTokens } from "./schema.js";

const TOKEN_PREFIX = "swz_";
const TOKEN_RANDOM_BYTES = 32;
const TOKEN_PREFIX_LENGTH = 10;
// A token's last_used_at is written at most this often, so bearer requests do not queue on one row
// lock; the dashboard shows a last use up to this much out of date.
const TOKEN_TOUCH_INTERVAL_MS = 60 * 1_000;
const TOKEN_NAME_MAX_LENGTH = 120;
const DEFAULT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_TOKEN_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;

import type { ApiTokenStore, StoredApiToken, TokenHolder } from "./api-token-types.js";

export type {
  ApiTokenStore,
  CreateApiTokenInput,
  CreatedApiToken,
  StoredApiToken,
  TokenHolder,
} from "./api-token-types.js";

export function generateApiTokenPlaintext(): string {
  const random = randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  return `${TOKEN_PREFIX}${random}`;
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function extractApiTokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LENGTH);
}

export function createPostgresApiTokenStore(
  options: { readonly client?: DatabaseClient; readonly connectionString?: string } = {},
): ApiTokenStore {
  const client =
    options.client ??
    createDatabaseClient(
      options.connectionString !== undefined ? { connectionString: options.connectionString } : {},
    );
  const ownsClient = options.client === undefined;
  const { db } = client;

  const selectTokens = () => db.select().from(apiTokens);
  const heldBy = (holder: TokenHolder): SQL => {
    switch (holder.kind) {
      case "person":
        return eq(apiTokens.userId, holder.userId);
      case "service-account":
        return eq(apiTokens.serviceAccountId, holder.serviceAccountId);
      case "worker":
        return eq(apiTokens.workerId, holder.workerId);
    }
  };
  /**
   * The holder's token by id, else its live token by name, else a revoked one of that name. An id
   * wins over a name, so a token named like another's id never stands in for it.
   */
  const find = async (holder: TokenHolder, identifier: string) => {
    const trimmed = identifier.trim();
    if (trimmed.length === 0) {
      throw new CodedError("API_TOKEN_NAME_REQUIRED", "Token identifier must not be empty.");
    }
    const rows = await selectTokens()
      .where(
        and(
          heldBy(holder),
          isUuid(trimmed)
            ? or(eq(apiTokens.id, trimmed), eq(apiTokens.name, trimmed))
            : eq(apiTokens.name, trimmed),
        ),
      )
      .orderBy(desc(apiTokens.createdAt));
    return pick(rows, trimmed);
  };
  const insert = async (
    tx: Pick<DatabaseClient["db"], "insert">,
    input: {
      readonly holder: TokenHolder;
      readonly name: string;
      readonly scope: TokenScope;
      readonly issuedBy: PersonOnRecord | null;
      readonly expiresAt: Date;
      readonly plaintext?: string;
    },
  ) => {
    const plaintext = tokenPlaintext(input.plaintext);
    try {
      const [inserted] = await tx
        .insert(apiTokens)
        .values({
          environments: input.scope.environments === null ? null : [...input.scope.environments],
          expiresAt: input.expiresAt,
          issuedBy: input.issuedBy?.id ?? null,
          issuedByName: input.issuedBy?.name ?? null,
          name: input.name,
          projectIds: input.scope.projectIds === null ? null : [...input.scope.projectIds],
          role: input.scope.role,
          serviceAccountId:
            input.holder.kind === "service-account" ? input.holder.serviceAccountId : null,
          workerId: input.holder.kind === "worker" ? input.holder.workerId : null,
          tokenHash: hashApiToken(plaintext),
          tokenPrefix: extractApiTokenPrefix(plaintext),
          userId: input.holder.kind === "person" ? input.holder.userId : null,
        })
        .returning();
      if (inserted === undefined) throw new Error("Failed to persist API token.");
      return { inserted, plaintext };
    } catch (error) {
      if (causeCode(error) === PG_ERROR.uniqueViolation) throw nameConflict(input.name);
      throw error;
    }
  };
  return {
    async createToken(input) {
      const name = validTokenName(input.name);
      const scope = validScope(input.holder, input.scope);
      const expiresAt = normalizeExpiration(input.expiresAt, input.holder);
      const { inserted, plaintext } = await insert(db, {
        expiresAt,
        holder: input.holder,
        ...(input.plaintext === undefined ? {} : { plaintext: input.plaintext }),
        issuedBy: input.issuedBy,
        name,
        scope,
      });
      return { ...mapRow(inserted), token: plaintext };
    },

    async listTokens(holder) {
      const rows = await selectTokens().where(heldBy(holder)).orderBy(desc(apiTokens.createdAt));
      return rows.map(mapRow);
    },

    async revokeAllTokens(userId) {
      await db
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
    },

    async revokeToken(holder, identifier) {
      const existing = await find(holder, identifier);
      if (existing === undefined) return null;
      if (existing.revokedAt !== null) return mapRow(existing);
      const [updated] = await db
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.id, existing.id), isNull(apiTokens.revokedAt)))
        .returning();
      return mapRow(updated ?? existing);
    },

    async rotateToken(holder, identifier, issuedBy, plaintext) {
      if (plaintext !== undefined) tokenPlaintext(plaintext);
      const old = await find(holder, identifier);
      if (
        old === undefined ||
        !isLiveRow(old, new Date()) ||
        (plaintext !== undefined && hashApiToken(plaintext) === old.tokenHash)
      )
        return null;
      return await db.transaction(async (tx) => {
        // The guard makes a concurrent second rotation, or an expiry meanwhile, match nothing.
        const now = new Date();
        const revoked = await tx
          .update(apiTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(apiTokens.id, old.id),
              isNull(apiTokens.revokedAt),
              gt(apiTokens.expiresAt, now),
            ),
          )
          .returning({ id: apiTokens.id });
        if (revoked.length === 0) return null;
        const lifetime = old.expiresAt.getTime() - old.createdAt.getTime();
        const minted = await insert(tx, {
          expiresAt: new Date(Date.now() + Math.min(lifetime, MAX_TOKEN_LIFETIME_MS)),
          holder,
          ...(plaintext === undefined ? {} : { plaintext }),
          issuedBy,
          name: old.name,
          scope: scopeOf(old),
        });
        return { ...mapRow(minted.inserted), token: minted.plaintext };
      });
    },

    async verifyToken(rawToken) {
      if (typeof rawToken !== "string" || rawToken.length === 0) {
        return null;
      }

      const providedHash = hashApiToken(rawToken);
      const now = new Date();

      const [row] = await selectTokens()
        .where(
          and(
            eq(apiTokens.tokenHash, providedHash),
            isNull(apiTokens.revokedAt),
            gt(apiTokens.expiresAt, now),
          ),
        )
        .limit(1);

      if (row === undefined) {
        return null;
      }

      const storedHashBuf = Buffer.from(row.tokenHash, "hex");
      const providedHashBuf = Buffer.from(providedHash, "hex");
      if (
        storedHashBuf.length !== providedHashBuf.length ||
        !timingSafeEqual(storedHashBuf, providedHashBuf)
      ) {
        return null;
      }

      const touchBefore = new Date(now.getTime() - TOKEN_TOUCH_INTERVAL_MS);
      if (row.lastUsedAt !== null && row.lastUsedAt > touchBefore) {
        return mapRow(row);
      }

      // The guard repeats the check in SQL: concurrent first uses after the interval write once,
      // because the waiting updates re-read the committed row and match nothing.
      await db
        .update(apiTokens)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(apiTokens.id, row.id),
            or(isNull(apiTokens.lastUsedAt), lte(apiTokens.lastUsedAt, touchBefore)),
          ),
        );

      return mapRow({ ...row, lastUsedAt: now });
    },

    async isLive(tokenId) {
      const [row] = await db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.id, tokenId),
            isNull(apiTokens.revokedAt),
            gt(apiTokens.expiresAt, new Date()),
          ),
        );
      return row !== undefined;
    },

    async close() {
      if (ownsClient) {
        await client.close();
      }
    },
  };
}

/** For tests. */

/** Among a holder's tokens matching an identifier, newest first: the one it names. */
function pick<T extends { readonly id: string; readonly revokedAt: Date | null }>(
  rows: readonly T[],
  identifier: string,
): T | undefined {
  return (
    rows.find((row) => row.id === identifier) ??
    rows.find((row) => row.revokedAt === null) ??
    rows[0]
  );
}

function isLiveRow(
  row: { readonly revokedAt: Date | null; readonly expiresAt: Date },
  now: Date,
): boolean {
  return row.revokedAt === null && row.expiresAt > now;
}

function validTokenName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new CodedError("API_TOKEN_NAME_REQUIRED", "Token name must not be empty.");
  }
  if (name.length > TOKEN_NAME_MAX_LENGTH) {
    throw new CodedError(
      "API_TOKEN_NAME_TOO_LONG",
      `Token name must be ${TOKEN_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  return name;
}

/**
 * A scope as stored: lists without duplicates and never empty. A service account token carries at
 * most SERVICE_ACCOUNT_MAX_ROLE and no project list, since its account acts in one project only.
 */
function validScope(holder: TokenHolder, scope: TokenScope): TokenScope {
  const invalid = (message: string) => new CodedError("API_TOKEN_SCOPE_INVALID", message);
  if (!PROJECT_ROLES.includes(scope.role)) throw invalid(`Unknown role: ${scope.role}.`);
  const list = (values: readonly string[] | null, what: string) => {
    if (values === null) return null;
    const unique = [...new Set(values.map((value) => value.trim()))];
    if (unique.length === 0 || unique.some((value) => value.length === 0)) {
      throw invalid(`A token's ${what} list names at least one, and no empty name.`);
    }
    return unique;
  };
  if (holder.kind === "service-account") {
    if (scope.role === "admin") {
      throw invalid(`A service account token carries at most ${SERVICE_ACCOUNT_MAX_ROLE}.`);
    }
    if (scope.projectIds !== null) {
      throw invalid("A service account token acts in its account's project; it names no projects.");
    }
  }
  return {
    environments: list(scope.environments, "environment"),
    projectIds: list(scope.projectIds, "project"),
    role: scope.role,
  };
}

function normalizeExpiration(value: string | undefined, holder: TokenHolder): Date {
  const now = Date.now();
  const expiresAt =
    value === undefined ? new Date(now + DEFAULT_TOKEN_LIFETIME_MS) : new Date(value);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now ||
    (holder.kind !== "worker" && expiresAt.getTime() > now + MAX_TOKEN_LIFETIME_MS)
  ) {
    throw new CodedError(
      "API_TOKEN_EXPIRATION_INVALID",
      "Token expiration must be a valid future timestamp no more than 366 days away.",
    );
  }
  return expiresAt;
}

function nameConflict(name: string): CodedError {
  return new CodedError("API_TOKEN_NAME_CONFLICT", `A live API token named "${name}" exists.`);
}

function scopeOf(row: typeof apiTokens.$inferSelect): TokenScope {
  return {
    environments: row.environments,
    projectIds: row.projectIds,
    role: row.role,
  };
}

function mapRow(row: typeof apiTokens.$inferSelect): StoredApiToken {
  let holder: TokenHolder;
  if (row.userId !== null) holder = { kind: "person", userId: row.userId };
  else if (row.serviceAccountId !== null) {
    holder = { kind: "service-account", serviceAccountId: row.serviceAccountId };
  } else if (row.workerId !== null) holder = { kind: "worker", workerId: row.workerId };
  else throw new Error("API token has no holder.");
  return {
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    id: row.id,
    issuedBy:
      row.issuedBy === null || row.issuedByName === null
        ? null
        : { id: row.issuedBy, name: row.issuedByName },
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    name: row.name,
    holder,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    scope: scopeOf(row),
    tokenPrefix: row.tokenPrefix,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function tokenPlaintext(candidate: string | undefined): string {
  if (candidate === undefined) return generateApiTokenPlaintext();
  if (!/^swz_[A-Za-z0-9_-]{43}$/u.test(candidate)) {
    throw new CodedError(
      "API_TOKEN_SCOPE_INVALID",
      "Token must contain 32 opaque random bytes with the swz_ prefix.",
    );
  }
  return candidate;
}
