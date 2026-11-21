import { and, count, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { ReadScope } from "./access.js";
import type { DatabaseClient } from "./client.js";
import type { PlatformRunStatus } from "./control-plane-types.js";
import { listDeploymentChanges } from "./dashboard-automations.js";
import { ownedInScope } from "./dashboard-shared.js";
import type {
  DashboardHourCounts,
  DashboardTimetable,
  DashboardTimetableRow,
  TimetableClock,
} from "./dashboard-types.js";
import { type RunState, runState, USER_CANCELLED } from "./run-status.js";
import { automations, deployments, runs } from "./schema.js";

const HOUR_MS = 60 * 60_000;
const HOURS = 24;
const DEPLOYMENT_LIMIT = 500;

function timetableStart(clock: TimetableClock): Date {
  const offsetMs = clock.utcOffsetMinutes * 60_000;
  const hourStart = Math.floor((clock.now.getTime() + offsetMs) / HOUR_MS) * HOUR_MS - offsetMs;
  return new Date(hourStart - (HOURS - 1) * HOUR_MS);
}

export async function getTimetable(
  client: DatabaseClient,
  environment: string,
  clock: TimetableClock,
  scope: ReadScope,
): Promise<DashboardTimetable> {
  const from = timetableStart(clock);
  const until = new Date(from.getTime() + HOURS * HOUR_MS);
  const fromSeconds = sql.raw(String(from.getTime() / 1000));
  const hour = sql<number>`floor((extract(epoch from ${runs.queuedAt}) - ${fromSeconds}) / 3600)::int`;
  const cancelled = sql<boolean>`coalesce(${runs.deadLetterReason} = ${sql.raw(`'${USER_CANCELLED}'`)}, false)`;
  const [counted, changes] = await Promise.all([
    client.db
      .select({
        automationSlug: automations.slug,
        cancelled,
        hour,
        runs: count(),
        status: runs.status,
      })
      .from(runs)
      .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
      .innerJoin(automations, eq(runs.automationId, automations.id))
      .where(
        and(
          eq(deployments.environment, environment),
          gte(runs.queuedAt, from),
          lt(runs.queuedAt, until),
          isNull(runs.parentRunId),
          ownedInScope(scope, runs),
        ),
      )
      .groupBy(automations.slug, hour, runs.status, cancelled),
    listDeploymentChanges(client, environment, from, DEPLOYMENT_LIMIT, scope),
  ]);

  interface Row {
    readonly hours: Partial<Record<RunState, number>>[];
    readonly deployments: { at: string; version: string }[];
  }
  const rows = new Map<string, Row>();
  const rowOf = (automationSlug: string) => {
    const known = rows.get(automationSlug);
    if (known !== undefined) return known;
    const row: Row = {
      deployments: [],
      hours: Array.from({ length: HOURS }, (): Partial<Record<RunState, number>> => ({})),
    };
    rows.set(automationSlug, row);
    return row;
  };
  for (const group of counted) {
    const state = runState({
      deadLetterReason: group.cancelled ? USER_CANCELLED : null,
      status: group.status as PlatformRunStatus,
    });
    const hourCounts = rowOf(group.automationSlug).hours[group.hour];
    if (hourCounts !== undefined) hourCounts[state] = (hourCounts[state] ?? 0) + group.runs;
  }
  for (const change of changes.toReversed()) {
    if (Date.parse(change.occurredAt) >= until.getTime()) continue;
    rowOf(change.automationSlug).deployments.push({
      at: change.occurredAt,
      version: change.change.version,
    });
  }

  return {
    from: from.toISOString(),
    rows: [...rows].map(
      ([automationSlug, row]): DashboardTimetableRow => ({
        automationSlug,
        deployments: row.deployments,
        hours: row.hours satisfies readonly DashboardHourCounts[],
      }),
    ),
  };
}
