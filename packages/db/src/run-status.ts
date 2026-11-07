import type { PlatformRunStatus } from "./control-plane-types.js";

/** Failed runs are finished: retryable failures belong to executions, whose run stays queued. */
/** Its type keeps each status's phase, so a copy typed `typeof RUN_STATUS_PHASE` must agree. */
export const RUN_STATUS_PHASE = {
  queued: "open",
  running: "open",
  waiting: "open",
  succeeded: "finished",
  failed: "finished",
  "dead-lettered": "finished",
} as const satisfies Record<PlatformRunStatus, "open" | "finished">;

export function isOpenRun(status: PlatformRunStatus): boolean {
  return RUN_STATUS_PHASE[status] === "open";
}

export function isFinishedRun(status: PlatformRunStatus): boolean {
  return RUN_STATUS_PHASE[status] === "finished";
}

/** The dead-letter reason of a run a person cancelled. */
export const USER_CANCELLED = "user-cancelled";

/** A run as its owner reads it: its status, or `cancelled`, because a cancelled run did not fail. */
export type RunState = PlatformRunStatus | "cancelled";

/** Every surface that counts, lists or draws failures reads this one decision. */
export function runState(run: {
  readonly deadLetterReason: string | null;
  readonly status: PlatformRunStatus;
}): RunState {
  return run.deadLetterReason === USER_CANCELLED ? "cancelled" : run.status;
}

export function isFailedState(state: RunState): boolean {
  return state === "failed" || state === "dead-lettered";
}

export const RUN_STATUSES = Object.keys(RUN_STATUS_PHASE).filter(
  (status): status is PlatformRunStatus => status in RUN_STATUS_PHASE,
);
export const OPEN_RUN_STATUSES = RUN_STATUSES.filter(isOpenRun);
export const FINISHED_RUN_STATUSES = RUN_STATUSES.filter(isFinishedRun);
