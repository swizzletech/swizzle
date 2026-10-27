import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { authBudgets } from "./schema.js";

export interface BudgetSpend {
  readonly allowed: boolean;
  readonly windowEndsAt: Date;
}
export type SpendBudget = (key: string, limit: number, windowMs: number) => Promise<BudgetSpend>;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const budgetKeyHash = (key: string): string => createHash("sha256").update(key).digest("hex");

/** Atomically spends a fixed window. Call outside a transaction that may reject the request. */
export async function spendBudget(
  db: DatabaseClient["db"],
  key: string,
  limit: number,
  windowMs: number,
): Promise<BudgetSpend> {
  const now = new Date();
  const windowEndsAt = new Date(now.getTime() + windowMs);
  await db
    .delete(authBudgets)
    .where(lt(authBudgets.windowEndsAt, new Date(now.getTime() - RETENTION_MS)));
  const [row] = await db
    .insert(authBudgets)
    .values({ keyHash: budgetKeyHash(key), attempts: 1, windowEndsAt })
    .onConflictDoUpdate({
      target: authBudgets.keyHash,
      set: {
        attempts: sql`CASE WHEN ${authBudgets.windowEndsAt} <= ${now} THEN 1 ELSE ${authBudgets.attempts} + 1 END`,
        windowEndsAt: sql`CASE WHEN ${authBudgets.windowEndsAt} <= ${now} THEN ${windowEndsAt} ELSE ${authBudgets.windowEndsAt} END`,
      },
    })
    .returning();
  if (row === undefined) throw new Error("The request budget was not spent.");
  return { allowed: row.attempts <= limit, windowEndsAt: row.windowEndsAt };
}
