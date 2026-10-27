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

export const RUN_STATUSES = Object.keys(RUN_STATUS_PHASE).filter(
  (status): status is PlatformRunStatus => status in RUN_STATUS_PHASE,
);
export const OPEN_RUN_STATUSES = RUN_STATUSES.filter(isOpenRun);
export const FINISHED_RUN_STATUSES = RUN_STATUSES.filter(isFinishedRun);
