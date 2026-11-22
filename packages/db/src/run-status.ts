import type { PlatformRunStatus } from "./control-plane-types.js";

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

export const USER_CANCELLED = "user-cancelled";
export const PARENT_CANCELLED = "parent-cancelled";
export const PARENT_FINISHED = "parent-finished";

export const CANCELLED_RUN_REASONS = [USER_CANCELLED, PARENT_CANCELLED, PARENT_FINISHED] as const;

export type RunState = PlatformRunStatus | "cancelled";

export function runState(run: {
  readonly deadLetterReason: string | null;
  readonly status: PlatformRunStatus;
}): RunState {
  return CANCELLED_RUN_REASONS.some((reason) => reason === run.deadLetterReason)
    ? "cancelled"
    : run.status;
}

export function isFailedState(state: RunState): boolean {
  return state === "failed" || state === "dead-lettered";
}

export const RUN_STATUSES = Object.keys(RUN_STATUS_PHASE).filter(
  (status): status is PlatformRunStatus => status in RUN_STATUS_PHASE,
);
export const RUN_STATES: readonly RunState[] = [...RUN_STATUSES, "cancelled"];
export const OPEN_RUN_STATUSES = RUN_STATUSES.filter(isOpenRun);
export const FINISHED_RUN_STATUSES = RUN_STATUSES.filter(isFinishedRun);
