// Runs in words: status, duration, where they ran, and their approvals.

import type { Assignee, RunDetail, RunListItem, RunStep } from "../api";
import { clockTime, durationInWords } from "./time";

type RunFacts = Pick<
  RunListItem,
  | "approval"
  | "attemptsMade"
  | "attemptsMax"
  | "deadLetterReason"
  | "finishedAt"
  | "startedAt"
  | "status"
  | "wait"
>;

export function runDurationMs(run: Pick<RunListItem, "finishedAt" | "startedAt">): number | null {
  if (run.startedAt === null || run.finishedAt === null) return null;
  return Date.parse(run.finishedAt) - Date.parse(run.startedAt);
}

/** The run panel's Duration: "Not started" until a worker starts the run, then "Still going" or "0.4 s". */
export function runDurationInWords(run: Pick<RunListItem, "finishedAt" | "startedAt">): string {
  if (run.startedAt === null) return "Not started";
  const duration = runDurationMs(run);
  return duration === null ? "Still going" : durationInWords(duration);
}

/**
 * The run panel's Ran on: the worker of a run that stayed on one, "1: gpu-box, 2: laptop" by
 * execution number when its executions moved, null before the first execution.
 */
export function ranOnInWords(
  executions: readonly Pick<RunDetail["executions"][number], "executionNumber" | "workerName">[],
): string | null {
  const names = new Set(executions.map((execution) => execution.workerName));
  if (names.size <= 1) return executions[0]?.workerName ?? null;
  return executions
    .map((execution) => `${execution.executionNumber}: ${execution.workerName}`)
    .join(", ");
}

/** The active execution may still be preparing its image and sandbox. */
export function runDetailStatusInWords(
  run: RunFacts & {
    readonly executions: readonly Pick<RunDetail["executions"][number], "phase">[];
  },
): string {
  return run.status === "running" && run.executions.at(-1)?.phase === "preparing"
    ? "Preparing"
    : runStatusInWords(run);
}

/**
 * "Failed after 2 attempts", "Waiting for approval", "Waiting until 14:00", "Succeeded in 0.4 s".
 */
export function runStatusInWords(run: RunFacts): string {
  switch (run.status) {
    case "succeeded": {
      const duration = runDurationMs(run);
      return duration === null ? "Succeeded" : `Succeeded in ${durationInWords(duration)}`;
    }
    case "failed":
    case "dead-lettered":
      if (run.deadLetterReason === "user-cancelled") return "Cancelled";
      return run.attemptsMade === 1
        ? "Failed after 1 attempt"
        : `Failed after ${run.attemptsMade} attempts`;
    case "waiting":
      if (run.approval !== null) return "Waiting for approval";
      if (run.wait?.reason === "sleep") {
        return `Waiting until ${clockTime(new Date(run.wait.until))}`;
      }
      if (run.wait?.reason === "child") return "Waiting for its child runs";
      return run.wait === null ? "Waiting for an event" : `Waiting for event ${run.wait.stepKey}`;
    case "running":
      return run.attemptsMade > 1 ? `Running, attempt ${run.attemptsMade}` : "Running";
    case "queued":
      return "Queued";
  }
}

/**
 * The line an approval shows under its question. Automations pass any JSON as details; a string,
 * or an object's message, question, summary or title, reads as words, anything else as compact JSON.
 */
export function approvalDetailsInWords(details: unknown): string | null {
  if (details === null || details === undefined) return null;
  if (typeof details === "string") return details;
  if (typeof details === "object" && !Array.isArray(details)) {
    const record = details as Record<string, unknown>;
    for (const key of ["message", "question", "summary", "title"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  const json = JSON.stringify(details);
  return json.length > 160 ? `${json.slice(0, 159)}…` : json;
}

/** How an approval step ended: the verdict and who gave it, or the timeout that ended it. */
export function approvalDecisionInWords(decision: NonNullable<RunStep["approval"]>): string {
  if (decision.timedOut) return "Timed out without a decision";
  const verdict = decision.approved ? "Approved" : "Rejected";
  switch (decision.decidedBy.kind) {
    case "person":
      return `${verdict} by ${decision.decidedBy.label}`;
    case "link":
      return `${verdict} through the approval link`;
  }
}

/** Who decides an approval: a person's email or a team's name; null for whoever may run it. */
export function assigneeInWords(assignee: Assignee | null): string | null {
  if (assignee === null) return null;
  return assignee.kind === "team" ? `the team ${assignee.label}` : assignee.label;
}
