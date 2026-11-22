import { and, asc, count, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { ReadScope } from "./access.js";
import type { DatabaseClient } from "./client.js";
import type { PlatformRunStatus } from "./control-plane-types.js";
import { automationsInScope, ownedInScope } from "./dashboard-shared.js";
import type {
  DashboardHourCounts,
  DashboardTimetable,
  DashboardTimetableRow,
  TimetableWindow,
} from "./dashboard-types.js";
import { TIMETABLE_HOURS } from "./dashboard-window.js";
import { type RunState, runState } from "./run-status.js";
import { auditEvents, automations, deployments, runs } from "./schema.js";

const DEPLOYMENT_LIMIT = 24;

function listDeploymentMarkers(
  client: DatabaseClient,
  environment: string,
  from: Date,
  until: Date,
  scope: ReadScope,
) {
  const markers = client.db
    .select({
      at: auditEvents.occurredAt,
      id: auditEvents.id,
      version: sql<string>`${auditEvents.change}->>'version'`.as("version"),
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.automationId, automations.id),
        eq(auditEvents.environment, environment),
        gte(auditEvents.occurredAt, from),
        lt(auditEvents.occurredAt, until),
        sql`${auditEvents.change}->>'kind' = 'deployment'`,
        ownedInScope(scope, auditEvents),
      ),
    )
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(DEPLOYMENT_LIMIT)
    .as("markers");

  return client.db
    .select({ at: markers.at, automationSlug: automations.slug, version: markers.version })
    .from(automations)
    .innerJoinLateral(markers, sql`true`)
    .where(automationsInScope(scope))
    .orderBy(asc(markers.at), asc(markers.id));
}

export async function getTimetable(
  client: DatabaseClient,
  environment: string,
  { from, until }: TimetableWindow,
  scope: ReadScope,
): Promise<DashboardTimetable> {
  const fromSeconds = sql.raw(String(from.getTime() / 1000));
  const hour = sql<number>`floor((extract(epoch from ${runs.queuedAt}) - ${fromSeconds}) / 3600)::int`;
  const [counted, changes] = await Promise.all([
    client.db
      .select({
        automationSlug: automations.slug,
        deadLetterReason: runs.deadLetterReason,
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
      .groupBy(automations.slug, hour, runs.status, runs.deadLetterReason),
    listDeploymentMarkers(client, environment, from, until, scope),
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
      hours: Array.from({ length: TIMETABLE_HOURS }, (): Partial<Record<RunState, number>> => ({})),
    };
    rows.set(automationSlug, row);
    return row;
  };
  for (const group of counted) {
    const state = runState({
      deadLetterReason: group.deadLetterReason,
      status: group.status as PlatformRunStatus,
    });
    const hourCounts = rowOf(group.automationSlug).hours[group.hour];
    if (hourCounts !== undefined) hourCounts[state] = (hourCounts[state] ?? 0) + group.runs;
  }
  for (const marker of changes) {
    rowOf(marker.automationSlug).deployments.push({
      at: marker.at.toISOString(),
      version: marker.version,
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
