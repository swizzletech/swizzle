import { inArray, sql } from "drizzle-orm";
import { CANCELLED_RUN_REASONS, type RunState } from "./run-status.js";
import { runs } from "./schema.js";

export function isCancelledRunSql() {
  return sql<boolean>`coalesce(${inArray(runs.deadLetterReason, CANCELLED_RUN_REASONS)}, false)`;
}

export function runStateSql() {
  return sql<RunState>`case when ${isCancelledRunSql()} then 'cancelled' else ${runs.status} end`;
}
