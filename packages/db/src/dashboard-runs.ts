import type { WorkerService } from "@swizzle/config";
import { and, count, desc, eq, gte, inArray, isNull, or, type SQLWrapper, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ReadScope } from "./access.js";
import type { DatabaseClient } from "./client.js";
import type { StoredRun } from "./control-plane-types.js";
import {
  automationsInScope,
  inCurrentProject,
  normalizeLimit,
  ownedInScope,
} from "./dashboard-shared.js";
import type {
  DashboardObservedInvocation,
  DashboardQueuedRuns,
  DashboardRunGlance,
  DashboardRunListItem,
  DashboardRunsQuery,
  DashboardRunsResult,
} from "./dashboard-types.js";
import { getRunApproval } from "./run-approval.js";
import { automations, automationVersions, deployments, runs } from "./schema.js";

/**
 * Which automations started child runs of which others since `since`, as distinct slug pairs,
 * naming only children `scope` lets the viewer read.
 */
export async function listObservedInvocations(
  client: DatabaseClient,
  environment: string,
  since: Date,
  scope: ReadScope,
): Promise<readonly DashboardObservedInvocation[]> {
  const parentRuns = alias(runs, "parent_runs");
  const parentAutomations = alias(automations, "parent_automations");
  return await client.db
    .selectDistinct({ childSlug: automations.slug, parentSlug: parentAutomations.slug })
    .from(runs)
    .innerJoin(parentRuns, eq(runs.parentRunId, parentRuns.id))
    .innerJoin(automations, eq(runs.automationId, automations.id))
    .innerJoin(parentAutomations, eq(parentRuns.automationId, parentAutomations.id))
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(
      and(
        eq(deployments.environment, environment),
        gte(runs.queuedAt, since),
        automationsInScope(scope),
      ),
    );
}

// A correlated self-count needs an explicit alias in raw SQL: interpolating a
// Drizzle alias() table into sql`` renders only the alias name ("child_runs"),
// which Postgres rejects as an unknown relation.
function childRunCountSubquery(parentColumn: SQLWrapper) {
  return sql<number>`(select count(*)::int from ${runs} as child_runs where child_runs.parent_run_id = ${parentColumn})`.as(
    "child_run_count",
  );
}

export async function listRuns(
  client: DatabaseClient,
  query: DashboardRunsQuery,
): Promise<DashboardRunsResult> {
  const { environment } = query;
  const filters = [eq(deployments.environment, environment), ownedInScope(query.scope, runs)];

  if (query.automationSlug !== undefined && query.automationSlug !== "") {
    filters.push(eq(automations.slug, query.automationSlug));
  }

  if (query.statuses !== undefined && query.statuses.length > 0) {
    filters.push(inArray(runs.status, [...query.statuses]));
  }

  if (query.triggerType !== undefined) {
    filters.push(eq(runs.triggerType, query.triggerType));
  }

  if (query.parentRunId !== undefined && query.parentRunId !== "") {
    filters.push(eq(runs.parentRunId, query.parentRunId));
  }

  if (query.topLevelOnly === true) {
    filters.push(sql`${runs.parentRunId} is null`);
  }

  if (query.approvalOnly === true) {
    filters.push(eq(runs.status, "waiting"));
    filters.push(eq(sql`${runs.wait}->>'reason'`, "approval"));
  }

  if (query.assignedTo !== undefined) {
    const userIds = query.assignedTo.flatMap((subject) =>
      subject.kind === "user" ? [subject.userId] : [],
    );
    const teamIds = query.assignedTo.flatMap((subject) =>
      subject.kind === "team" ? [subject.teamId] : [],
    );
    filters.push(
      or(
        sql`(${runs.wait}->'assignee') = 'null'::jsonb`,
        userIds.length === 0
          ? undefined
          : inArray(sql`${runs.wait}->'assignee'->>'userId'`, userIds),
        teamIds.length === 0
          ? undefined
          : inArray(sql`${runs.wait}->'assignee'->>'teamId'`, teamIds),
      ) ?? sql`true`,
    );
  }

  const limit = normalizeLimit(query.limit);
  const rows = await client.db
    .select({
      attemptsMade: runs.attemptsMade,
      attemptsMax: runs.attemptsMax,
      automationId: automations.id,
      automationName: automations.name,
      automationSlug: automations.slug,
      childRunCount: childRunCountSubquery(runs.id),
      chainOriginRunId: runs.chainOriginRunId,
      chainSourceRunIds: runs.chainSourceRunIds,
      deadLetterReason: runs.deadLetterReason,
      deploymentId: runs.deploymentId,
      environment: deployments.environment,
      errorClassification: runs.errorClassification,
      errorCode: runs.errorCode,
      errorMessage: runs.errorMessage,
      finishedAt: runs.finishedAt,
      parentRunId: runs.parentRunId,
      parentStepKey: runs.parentStepKey,
      projectId: runs.projectId,
      queuedAt: runs.queuedAt,
      runId: runs.id,
      startedAt: runs.startedAt,
      status: runs.status,
      triggerType: runs.triggerType,
      version: automationVersions.version,
      versionId: automationVersions.id,
      wait: runs.wait,
    })
    .from(runs)
    .innerJoin(automations, eq(runs.automationId, automations.id))
    .innerJoin(automationVersions, eq(runs.versionId, automationVersions.id))
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(and(...filters))
    .orderBy(desc(runs.queuedAt))
    .limit(limit);

  return {
    environment,
    filters: {
      automationSlug: query.automationSlug ?? null,
      limit,
      statuses: query.statuses ?? [],
      triggerType: query.triggerType ?? null,
    },
    runs: rows.map(mapRunRow),
  };
}

/** Each automation's newest run in `environment`. */
export async function listLatestRunsByAutomation(
  client: DatabaseClient,
  environment: string,
  automationIds: readonly string[],
): Promise<readonly DashboardRunListItem[]> {
  if (automationIds.length === 0) {
    return [];
  }

  const rankedRuns = client.db
    .select({
      attemptsMade: runs.attemptsMade,
      attemptsMax: runs.attemptsMax,
      automationId: runs.automationId,
      projectId: runs.projectId,
      chainOriginRunId: runs.chainOriginRunId,
      chainSourceRunIds: runs.chainSourceRunIds,
      deadLetterReason: runs.deadLetterReason,
      deploymentId: runs.deploymentId,
      errorClassification: runs.errorClassification,
      errorCode: runs.errorCode,
      errorMessage: runs.errorMessage,
      finishedAt: runs.finishedAt,
      parentRunId: runs.parentRunId,
      parentStepKey: runs.parentStepKey,
      queuedAt: runs.queuedAt,
      runId: runs.id,
      startedAt: runs.startedAt,
      status: runs.status,
      triggerType: runs.triggerType,
      versionId: runs.versionId,
      wait: runs.wait,
      runRank:
        sql<number>`row_number() over (partition by ${runs.automationId} order by ${runs.queuedAt} desc, ${runs.id} desc)`.as(
          "run_rank",
        ),
    })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .innerJoin(automations, eq(runs.automationId, automations.id))
    .where(
      and(
        inArray(runs.automationId, [...automationIds]),
        eq(deployments.environment, environment),
        inCurrentProject,
      ),
    )
    .as("ranked_runs");

  const runRows = await client.db
    .select({
      attemptsMade: rankedRuns.attemptsMade,
      attemptsMax: rankedRuns.attemptsMax,
      automationId: rankedRuns.automationId,
      projectId: rankedRuns.projectId,
      automationName: automations.name,
      automationSlug: automations.slug,
      childRunCount: childRunCountSubquery(rankedRuns.runId),
      chainOriginRunId: rankedRuns.chainOriginRunId,
      chainSourceRunIds: rankedRuns.chainSourceRunIds,
      deadLetterReason: rankedRuns.deadLetterReason,
      deploymentId: rankedRuns.deploymentId,
      environment: deployments.environment,
      errorClassification: rankedRuns.errorClassification,
      errorCode: rankedRuns.errorCode,
      errorMessage: rankedRuns.errorMessage,
      finishedAt: rankedRuns.finishedAt,
      parentRunId: rankedRuns.parentRunId,
      parentStepKey: rankedRuns.parentStepKey,
      queuedAt: rankedRuns.queuedAt,
      runId: rankedRuns.runId,
      startedAt: rankedRuns.startedAt,
      status: rankedRuns.status,
      triggerType: rankedRuns.triggerType,
      version: automationVersions.version,
      versionId: rankedRuns.versionId,
      wait: rankedRuns.wait,
    })
    .from(rankedRuns)
    .innerJoin(automations, eq(rankedRuns.automationId, automations.id))
    .innerJoin(automationVersions, eq(rankedRuns.versionId, automationVersions.id))
    .innerJoin(deployments, eq(rankedRuns.deploymentId, deployments.id))
    .where(eq(rankedRuns.runRank, 1))
    .orderBy(desc(rankedRuns.queuedAt));

  return runRows.map(mapRunRow);
}

/** The last `perAutomation` top-level runs of each automation in the environment, newest first. */
export async function listRecentRunGlances(
  client: DatabaseClient,
  environment: string,
  automationIds: readonly string[],
  perAutomation: number,
): Promise<ReadonlyMap<string, readonly DashboardRunGlance[]>> {
  const glances = new Map<string, DashboardRunGlance[]>();
  if (automationIds.length === 0) {
    return glances;
  }

  const ranked = client.db
    .select({
      automationId: runs.automationId,
      errorCode: runs.errorCode,
      errorMessage: runs.errorMessage,
      queuedAt: runs.queuedAt,
      runId: runs.id,
      status: runs.status,
      runRank:
        sql<number>`row_number() over (partition by ${runs.automationId} order by ${runs.queuedAt} desc, ${runs.id} desc)`.as(
          "run_rank",
        ),
    })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .innerJoin(automations, eq(runs.automationId, automations.id))
    .where(
      and(
        inArray(runs.automationId, [...automationIds]),
        eq(deployments.environment, environment),
        isNull(runs.parentRunId),
        inCurrentProject,
      ),
    )
    .as("ranked_glances");
  const rows = await client.db
    .select()
    .from(ranked)
    .where(sql`${ranked.runRank} <= ${perAutomation}`)
    .orderBy(ranked.automationId, desc(ranked.queuedAt));

  for (const row of rows) {
    const glance = {
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      queuedAt: row.queuedAt.toISOString(),
      runId: row.runId,
      status: row.status as DashboardRunGlance["status"],
    };
    const list = glances.get(row.automationId);
    if (list) {
      list.push(glance);
    } else {
      glances.set(row.automationId, [glance]);
    }
  }
  return glances;
}

/** Top-level runs of the environment queued since `since`, counted by status. */
export async function countRunsSince(
  client: DatabaseClient,
  environment: string,
  since: Date,
  scope: ReadScope,
): Promise<Record<DashboardRunListItem["status"], number>> {
  const rows = await client.db
    .select({ runs: count(), status: runs.status })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .innerJoin(automations, eq(runs.automationId, automations.id))
    .where(
      and(
        eq(deployments.environment, environment),
        gte(runs.queuedAt, since),
        isNull(runs.parentRunId),
        ownedInScope(scope, runs),
      ),
    )
    .groupBy(runs.status);

  const counts: Record<DashboardRunListItem["status"], number> = {
    "dead-lettered": 0,
    failed: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    waiting: 0,
  };
  for (const row of rows) {
    counts[row.status as DashboardRunListItem["status"]] = row.runs;
  }
  return counts;
}

function mapRunRow(row: {
  readonly attemptsMade: number;
  readonly attemptsMax: number;
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly childRunCount: number;
  readonly chainOriginRunId: string | null;
  readonly chainSourceRunIds: readonly string[];
  readonly deadLetterReason: string | null;
  readonly deploymentId: string;
  readonly environment: string;
  readonly errorClassification: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly finishedAt: Date | null;
  readonly parentRunId: string | null;
  readonly parentStepKey: string | null;
  readonly projectId: string;
  readonly queuedAt: Date;
  readonly runId: string;
  readonly startedAt: Date | null;
  readonly status: string;
  readonly triggerType: string;
  readonly version: string;
  readonly versionId: string;
  readonly wait: StoredRun["wait"];
}): DashboardRunListItem {
  return {
    approval: getRunApproval(row),
    attemptsMade: row.attemptsMade,
    attemptsMax: row.attemptsMax,
    automationId: row.automationId,
    automationName: row.automationName,
    automationSlug: row.automationSlug,
    projectId: row.projectId,
    childRunCount: row.childRunCount,
    chainOriginRunId: row.chainOriginRunId,
    chainSourceRunIds: row.chainSourceRunIds,
    deadLetterReason: row.deadLetterReason,
    deploymentId: row.deploymentId,
    environment: row.environment,
    errorClassification:
      (row.errorClassification as DashboardRunListItem["errorClassification"]) ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    parentRunId: row.parentRunId,
    parentStepKey: row.parentStepKey,
    queuedAt: row.queuedAt.toISOString(),
    runId: row.runId,
    startedAt: row.startedAt?.toISOString() ?? null,
    status: row.status as DashboardRunListItem["status"],
    triggerType: row.triggerType as DashboardRunListItem["triggerType"],
    version: row.version,
    versionId: row.versionId,
    wait: row.wait,
  };
}

/**
 * The queued runs of an environment by what placement reads of them: one row per automation,
 * project, group and services, with the oldest run and the earliest deadline.
 */
export async function listQueuedRuns(
  client: DatabaseClient,
  environment: string,
  scope: ReadScope,
): Promise<readonly DashboardQueuedRuns[]> {
  const runtime = deployments.runtimeSnapshot;
  const profile = sql<string>`${runtime}->>'profile'`;
  const services = sql<WorkerService[]>`${runtime}->'permissions'->'services'`;
  const queueTimeout = sql<string>`${runtime}->>'queue_timeout'`;
  const rows = await client.db
    .select({
      automationName: automations.name,
      automationSlug: automations.slug,
      projectId: runs.projectId,
      profile,
      services,
      queueTimeout,
      queued: count(),
      runId: sql<string>`(array_agg(${runs.id} order by ${runs.queuedAt}))[1]`,
      deadline: sql<string>`min(${runs.placementDeadlineAt})`,
    })
    .from(runs)
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .innerJoin(automations, eq(runs.automationId, automations.id))
    .where(
      and(
        eq(runs.status, "queued"),
        eq(deployments.environment, environment),
        ownedInScope(scope, runs),
      ),
    )
    .groupBy(automations.name, automations.slug, runs.projectId, profile, services, queueTimeout);
  return rows.map(({ automationName, automationSlug, deadline, ...row }) => ({
    ...row,
    automation: { automationName, automationSlug },
    environment,
    deadline: new Date(deadline).toISOString(),
  }));
}
