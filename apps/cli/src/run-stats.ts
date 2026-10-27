import type { RunDetailRecord, RunSummaryRecord } from "./run-records.js";

export interface RunStats {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly queued: number;
  readonly running: number;
  readonly waiting: number;
  readonly successRate: number | null;
  readonly lastRunAt: string | null;
  readonly lastFailure: {
    readonly runId: string;
    readonly errorCode: string | null;
  } | null;
  readonly topErrors: readonly { readonly code: string; readonly count: number }[];
}

export function aggregateRunStats(
  runs: readonly RunSummaryRecord[],
  failureDetails: readonly RunDetailRecord[],
): RunStats {
  let succeeded = 0;
  let failed = 0;
  let deadLettered = 0;
  let queued = 0;
  let running = 0;
  let waiting = 0;
  for (const run of runs) {
    switch (run.status) {
      case "succeeded":
        succeeded++;
        break;
      case "failed":
        failed++;
        break;
      case "dead-lettered":
        deadLettered++;
        break;
      case "queued":
        queued++;
        break;
      case "running":
        running++;
        break;
      case "waiting":
        waiting++;
        break;
      default:
        throw new Error(`Unknown run status: ${run.status}`);
    }
  }
  const total = runs.length;
  const terminal = succeeded + failed + deadLettered;
  const successRate = terminal === 0 ? null : succeeded / terminal;
  const sorted = [...runs].sort((a, b) => (b.queuedAt ?? "").localeCompare(a.queuedAt ?? ""));
  const lastRunAt = sorted[0]?.queuedAt ?? null;

  const errorCounts = new Map<string, number>();
  for (const detail of failureDetails) {
    const code = detail.errorCode ?? "UNKNOWN";
    errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1);
  }
  const topErrors = [...errorCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const lastFailure = failureDetails[0]
    ? { errorCode: failureDetails[0].errorCode ?? null, runId: failureDetails[0].runId }
    : null;

  // The order is the output order: counts first, then what to look at next.
  return {
    total,
    succeeded,
    failed,
    deadLettered,
    running,
    queued,
    waiting,
    successRate,
    topErrors,
    lastFailure,
    lastRunAt,
  };
}

export function filterRunsByTimeRange(
  runs: readonly RunSummaryRecord[],
  range: { readonly since?: string; readonly until?: string },
): readonly RunSummaryRecord[] {
  if (!range.since && !range.until) return runs;
  return runs.filter((run) => {
    if (!run.queuedAt) return true;
    if (range.since && run.queuedAt < range.since) return false;
    if (range.until && run.queuedAt > range.until) return false;
    return true;
  });
}
