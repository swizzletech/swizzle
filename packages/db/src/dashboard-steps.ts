import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { inCurrentProject } from "./dashboard-shared.js";
import type { DashboardRunStep, DashboardStepReach } from "./dashboard-types.js";
import { stepResultView } from "./run-approval.js";
import {
  automationNamed,
  automations,
  deployments,
  runExecutions,
  runSteps,
  runs,
} from "./schema.js";

export async function listRunSteps(
  client: DatabaseClient,
  input: { readonly runId: string },
): Promise<readonly DashboardRunStep[]> {
  const rows = await client.db
    .select({
      attempt: runExecutions.attempt,
      executionNumber: runSteps.executionNumber,
      createdAt: runSteps.createdAt,
      finishedAt: runSteps.finishedAt,
      startedAt: runSteps.startedAt,
      stepKey: runSteps.stepKey,
      updatedAt: runSteps.updatedAt,
      value: runSteps.value,
    })
    .from(runSteps)
    // Every step is written by an execution of its run: the one that ran it or, for a wait's
    // result, the one that suspended.
    .innerJoin(
      runExecutions,
      and(
        eq(runExecutions.runId, runSteps.runId),
        eq(runExecutions.executionNumber, runSteps.executionNumber),
      ),
    )
    .where(eq(runSteps.runId, input.runId))
    .orderBy(asc(runSteps.createdAt), asc(runSteps.stepKey));

  return rows.map((row) => ({
    attempt: row.attempt,
    executionNumber: row.executionNumber,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    stepKey: row.stepKey,
    updatedAt: row.updatedAt.toISOString(),
    ...stepResultView(row.value),
  }));
}

/** Over the automation's last `limit` runs in the environment: how many runs reached each step. */
export async function countStepReach(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
  limit: number,
): Promise<DashboardStepReach> {
  const recent = client.db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(automations, eq(runs.automationId, automations.id))
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(
      and(
        automationNamed(automationSlug),
        eq(deployments.environment, environment),
        inCurrentProject,
      ),
    )
    .orderBy(desc(runs.queuedAt))
    .limit(limit)
    .as("recent_runs");
  const [reachRows, [total]] = await Promise.all([
    client.db
      .select({ reached: count(runSteps.runId), stepKey: runSteps.stepKey })
      .from(runSteps)
      .where(inArray(runSteps.runId, client.db.select({ runId: recent.runId }).from(recent)))
      .groupBy(runSteps.stepKey),
    client.db.select({ runs: count() }).from(recent),
  ]);
  return {
    reached: Object.fromEntries(reachRows.map((row) => [row.stepKey, row.reached])),
    runs: total?.runs ?? 0,
  };
}
