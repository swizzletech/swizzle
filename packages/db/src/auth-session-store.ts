/**
 * Wraps the Better Auth database adapter so the session table holds only SHA-256 hashes of
 * session tokens, and so the persisted row decides when a session ends.
 *
 * - create stores H(token) and returns the row with the raw token, which only the response
 *   carries.
 * - Every query on the session token hashes its value, and a row found that way carries the
 *   token it was asked for. A stored digest presented as a cookie hashes to something else and
 *   finds nothing. A row found any other way, by user or id, carries its digest, which no
 *   lookup accepts; Swizzle lists and revokes sessions by id.
 * - expiresAt is signedInAt plus the absolute limit. Better Auth copies the old row into a rotated
 *   session, signedInAt included, so a rotation never moves the end; updates never write
 *   expiresAt.
 * - A token lookup finds only a session that has not expired and was seen within the idle limit,
 *   and it moves lastSeenAt forward when it is older than a tenth of the idle limit, at most
 *   five minutes. A session therefore ends between 90% and 100% of the idle limit after its last
 *   use, and an active session writes its row at most once per interval.
 */
import { createHash } from "node:crypto";

import type {
  BetterAuthOptions,
  DBAdapter,
  DBAdapterInstance,
  DBTransactionAdapter,
  Where,
} from "better-auth";

export interface SessionLimits {
  readonly absoluteMs: number;
  readonly idleMs: number;
}

const SESSION_MODEL = "session";
const MAX_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function withHashedSessions(
  inner: DBAdapterInstance,
  limits: SessionLimits,
): DBAdapterInstance {
  return (options) => wrap(inner(options), limits);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

interface SessionRow {
  readonly expiresAt: Date;
  readonly id: string;
  readonly lastSeenAt: Date;
  readonly signedInAt: Date;
  readonly token: string;
}

function wrap<Adapter extends DBTransactionAdapter<BetterAuthOptions>>(
  adapter: Adapter,
  limits: SessionLimits,
): Adapter {
  const isSession = (model: string) => model === SESSION_MODEL;
  const touchIntervalMs = Math.min(MAX_TOUCH_INTERVAL_MS, limits.idleMs / 10);

  /** The token condition hashed, and the raw tokens it named by their hash. */
  const hashWhere = (where: readonly Where[] | undefined) => {
    const tokens = new Map<string, string>();
    const hashOne = (raw: unknown) => {
      if (typeof raw !== "string") return raw;
      const digest = hashSessionToken(raw);
      tokens.set(digest, raw);
      return digest;
    };
    const hashed = where?.map((condition) =>
      condition.field !== "token"
        ? condition
        : {
            ...condition,
            value: Array.isArray(condition.value)
              ? condition.value.map(hashOne)
              : hashOne(condition.value),
          },
    ) as Where[] | undefined;
    const restore = <Row>(row: Row): Row => {
      if (row === null || typeof row !== "object") return row;
      const raw = tokens.get((row as { token?: unknown }).token as string);
      return raw === undefined ? row : { ...row, token: raw };
    };
    return { hasToken: tokens.size > 0, restore, where: hashed };
  };

  const live = (now: Date): Where[] => [
    { field: "expiresAt", operator: "gt", value: now },
    { field: "lastSeenAt", operator: "gt", value: new Date(now.getTime() - limits.idleMs) },
  ];

  const wrapped: Adapter = {
    ...adapter,

    async create(query) {
      if (!isSession(query.model)) return await adapter.create(query);
      const data = query.data as Record<string, unknown> & { token: string };
      const now = new Date();
      const signedInAt = data.signedInAt instanceof Date ? data.signedInAt : now;
      const row = await adapter.create({
        ...query,
        data: {
          ...data,
          expiresAt: new Date(signedInAt.getTime() + limits.absoluteMs),
          lastSeenAt: now,
          signedInAt,
          token: hashSessionToken(data.token),
        },
      });
      return { ...row, token: data.token };
    },

    async findOne(query) {
      if (!isSession(query.model)) return await adapter.findOne(query);
      const { hasToken, restore, where } = hashWhere(query.where);
      if (!hasToken) return await adapter.findOne({ ...query, where: where ?? [] });
      const now = new Date();
      const row = await adapter.findOne<SessionRow>({
        ...query,
        where: [...(where ?? []), ...live(now)],
      });
      if (row === null) return null;
      if (row.lastSeenAt.getTime() < now.getTime() - touchIntervalMs) {
        await adapter.update({
          model: SESSION_MODEL,
          update: { lastSeenAt: now },
          where: [{ field: "id", value: row.id }],
        });
      }
      return restore(row) as never;
    },

    async findMany(query) {
      if (!isSession(query.model)) return await adapter.findMany(query);
      const { restore, where } = hashWhere(query.where);
      const rows = await adapter.findMany({ ...query, ...(where ? { where } : {}) });
      return rows.map(restore);
    },

    async update(query) {
      if (!isSession(query.model)) return await adapter.update(query);
      const { restore, where } = hashWhere(query.where);
      const row = await adapter.update({
        ...query,
        update: withoutSessionEnd(query.update),
        where: where ?? [],
      });
      return restore(row);
    },

    async updateMany(query) {
      if (!isSession(query.model)) return await adapter.updateMany(query);
      return await adapter.updateMany({
        ...query,
        update: withoutSessionEnd(query.update),
        where: hashWhere(query.where).where ?? [],
      });
    },

    async delete(query) {
      if (!isSession(query.model)) return await adapter.delete(query);
      await adapter.delete({ ...query, where: hashWhere(query.where).where ?? [] });
    },

    async deleteMany(query) {
      if (!isSession(query.model)) return await adapter.deleteMany(query);
      return await adapter.deleteMany({ ...query, where: hashWhere(query.where).where ?? [] });
    },

    async consumeOne(query) {
      if (!isSession(query.model)) return await adapter.consumeOne(query);
      const { restore, where } = hashWhere(query.where);
      return restore(await adapter.consumeOne({ ...query, where: where ?? [] }));
    },

    async incrementOne(query) {
      if (!isSession(query.model)) return await adapter.incrementOne(query);
      const { restore, where } = hashWhere(query.where);
      return restore(await adapter.incrementOne({ ...query, where: where ?? [] }));
    },

    async count(query) {
      if (!isSession(query.model)) return await adapter.count(query);
      const { where } = hashWhere(query.where);
      return await adapter.count({ ...query, ...(where ? { where } : {}) });
    },
  };

  if ("transaction" in adapter && typeof adapter.transaction === "function") {
    const transaction = adapter.transaction.bind(
      adapter,
    ) as DBAdapter<BetterAuthOptions>["transaction"];
    (wrapped as unknown as DBAdapter<BetterAuthOptions>).transaction = (callback) =>
      transaction((trx) => callback(wrap(trx, limits)));
  }
  return wrapped;
}

/** The absolute end is fixed at creation; Better Auth's refresh would move it. */
function withoutSessionEnd(update: Record<string, unknown>): Record<string, unknown> {
  const { expiresAt: _ignored, token, ...rest } = update;
  return typeof token === "string" ? { ...rest, token: hashSessionToken(token) } : rest;
}
