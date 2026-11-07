// Runs in words: status, duration, where they ran, and their approvals.

import type { Assignee, HourCounts, RunDetail, RunListItem, RunState, RunStep } from "../api";
import { clockTime, durationInWords } from "./time";

type RunFacts = Pick<
  RunListItem,
  "approval" | "attemptsMade" | "attemptsMax" | "finishedAt" | "startedAt" | "state" | "wait"
>;

function runDurationMs(run: Pick<RunListItem, "finishedAt" | "startedAt">): number | null {
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
  return run.state === "running" && run.executions.at(-1)?.phase === "preparing"
    ? "Preparing"
    : runStatusInWords(run);
}

/** The states one hour of the timetable names, in this order, with the word for each. */
const HOUR_WORDS: readonly (readonly [readonly RunState[], string])[] = [
  [["succeeded"], "succeeded"],
  [["failed", "dead-lettered"], "failed"],
  [["cancelled"], "cancelled"],
  [["queued"], "queued"],
  [["running"], "running"],
  [["waiting"], "waiting"],
];

/** One hour of the timetable: "14:00 · 58 succeeded, 2 failed", or "14:00 · No runs". */
export function hourInWords(start: Date, counts: HourCounts): string {
  const parts = HOUR_WORDS.flatMap(([states, word]) => {
    const count = states.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
    return count === 0 ? [] : [`${count} ${word}`];
  });
  return `${clockTime(start)} · ${parts.length === 0 ? "No runs" : parts.join(", ")}`;
}

/** The one form of a version number on every surface: "v1.3.1". */
export function versionInWords(version: string): string {
  return `v${version}`;
}

/** A run row's two lines: the name above the state in a list of all runs, the state above the facts in one automation's. */
export function runRowInWords(
  run: RunFacts & Pick<RunListItem, "automationName" | "triggerType" | "version">,
  leads: "automation" | "state",
): { readonly title: string; readonly line: string } {
  const duration = runDurationMs(run);
  const facts = [
    ...(run.attemptsMade > 1 ? [`${run.attemptsMade} attempts`] : []),
    ...(duration === null ? [] : [durationInWords(duration)]),
  ];
  const state = shortStateInWords(run);
  return leads === "automation"
    ? { line: [state, ...facts].join(" · "), title: run.automationName }
    : { line: [...facts, run.triggerType, versionInWords(run.version)].join(" · "), title: state };
}

/** runStatusInWords without what a row's facts already say. */
function shortStateInWords(run: RunFacts): string {
  switch (run.state) {
    case "succeeded":
      return "Succeeded";
    case "running":
      return "Running";
    case "failed":
    case "dead-lettered":
      return "Failed";
    default:
      return runStatusInWords(run);
  }
}

/** The Runs head, and the end of a run list: only a list that reached its end says all. */
export function runCountInWords(count: number, complete: boolean): string {
  if (!complete) return `${count} newest`;
  return `${count} ${count === 1 ? "run" : "runs"}`;
}

/**
 * "Failed after 2 attempts", "Waiting for approval", "Waiting until 14:00", "Succeeded in 0.4 s".
 */
export function runStatusInWords(run: RunFacts): string {
  switch (run.state) {
    case "cancelled":
      return "Cancelled";
    case "succeeded": {
      const duration = runDurationMs(run);
      return duration === null ? "Succeeded" : `Succeeded in ${durationInWords(duration)}`;
    }
    case "failed":
    case "dead-lettered":
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
