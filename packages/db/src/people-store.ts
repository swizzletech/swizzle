/** Typed account persistence. Better Auth's adapter is reserved for its plugin transactions. */
import { and, asc, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import {
  authSessions,
  authTotpUses,
  authTwoFactors,
  authUsers,
  authVerifications,
  invitations,
} from "./schema.js";

export type UserRow = typeof authUsers.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;
type UserChange = Partial<Pick<UserRow, "role" | "suspendedAt" | "twoFactorEnabled">>;
type InvitationChange = Partial<
  Pick<InvitationRow, "revokedAt" | "userId" | "grants" | "grantedAt">
>;
interface InvitationFilter {
  readonly id?: string;
  readonly email?: string;
  readonly tokenHash?: string;
  readonly pending?: boolean;
}
export interface PeopleStore {
  transaction<T>(change: (tx: PeopleStore) => Promise<T>): Promise<T>;
  findUser(id: string): Promise<UserRow | null>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  listUsers(): Promise<UserRow[]>;
  hasUsers(): Promise<boolean>;
  countUsersWithoutTwoFactor(): Promise<number>;
  updateUser(id: string, change: UserChange): Promise<void>;
  deleteUser(id: string): Promise<void>;
  insertVerification(input: typeof authVerifications.$inferInsert): Promise<void>;
  deleteSessions(userId: string, sessionId?: string): Promise<number>;
  listSessions(userId: string): Promise<(typeof authSessions.$inferSelect)[]>;
  removeFactors(userId: string): Promise<number>;
  findInvitations(filter: InvitationFilter): Promise<InvitationRow[]>;
  insertInvitation(input: typeof invitations.$inferInsert): Promise<InvitationRow>;
  updateInvitation(
    id: string,
    change: InvitationChange,
    pendingOnly?: boolean,
  ): Promise<InvitationRow | null>;
  deleteInvitations(filter: InvitationFilter): Promise<void>;
}

export function createPostgresPeopleStore(db: DatabaseClient["db"]): PeopleStore {
  const invitationWhere = (filter: InvitationFilter) =>
    and(
      filter.id === undefined ? undefined : eq(invitations.id, filter.id),
      filter.email === undefined ? undefined : eq(invitations.email, filter.email),
      filter.tokenHash === undefined ? undefined : eq(invitations.tokenHash, filter.tokenHash),
      filter.pending
        ? and(
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, new Date()),
          )
        : undefined,
    );
  return {
    async transaction(change) {
      return await db.transaction(async (tx) => {
        // Every account-management transaction takes this lock, even when no owner row exists.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(193720, 1)`);
        return await change(createPostgresPeopleStore(tx));
      });
    },
    async insertVerification(input) {
      await db.insert(authVerifications).values(input);
    },
    async findUser(id) {
      const [row] = await db.select().from(authUsers).where(eq(authUsers.id, id));
      return row ?? null;
    },
    async findUserByEmail(email) {
      const [row] = await db.select().from(authUsers).where(eq(authUsers.email, email));
      return row ?? null;
    },
    async listUsers() {
      return await db.select().from(authUsers).orderBy(asc(authUsers.email));
    },
    async hasUsers() {
      return (await db.select({ id: authUsers.id }).from(authUsers).limit(1)).length !== 0;
    },
    async countUsersWithoutTwoFactor() {
      const [row] = await db
        .select({ count: count() })
        .from(authUsers)
        .where(eq(authUsers.twoFactorEnabled, false));
      if (row === undefined) throw new Error("The account count was not returned.");
      return row.count;
    },
    async updateUser(id, change) {
      await db.update(authUsers).set(change).where(eq(authUsers.id, id));
    },
    async deleteUser(id) {
      await db.delete(authUsers).where(eq(authUsers.id, id));
    },
    async deleteSessions(userId, sessionId) {
      const rows = await db
        .delete(authSessions)
        .where(
          and(
            eq(authSessions.userId, userId),
            sessionId === undefined ? undefined : eq(authSessions.id, sessionId),
          ),
        )
        .returning({ id: authSessions.id });
      return rows.length;
    },
    async listSessions(userId) {
      return await db.select().from(authSessions).where(eq(authSessions.userId, userId));
    },
    async removeFactors(userId) {
      await db.delete(authTotpUses).where(eq(authTotpUses.userId, userId));
      return (
        await db
          .delete(authTwoFactors)
          .where(eq(authTwoFactors.userId, userId))
          .returning({ id: authTwoFactors.id })
      ).length;
    },
    async findInvitations(filter) {
      return await db
        .select()
        .from(invitations)
        .where(invitationWhere(filter))
        .orderBy(desc(invitations.createdAt), desc(invitations.id));
    },
    async insertInvitation(input) {
      const [row] = await db.insert(invitations).values(input).returning();
      if (row === undefined) throw new Error("The invitation was not inserted.");
      return row;
    },
    async updateInvitation(id, change, pendingOnly = false) {
      const [row] = await db
        .update(invitations)
        .set(change)
        .where(invitationWhere({ id, pending: pendingOnly }))
        .returning();
      return row ?? null;
    },
    async deleteInvitations(filter) {
      await db.delete(invitations).where(invitationWhere(filter));
    },
  };
}
