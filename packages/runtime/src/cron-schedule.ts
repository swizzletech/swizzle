import { scheduler } from "node:timers/promises";
import { CronExpressionParser } from "cron-parser";

interface CronAdvance {
  readonly nextRunAt: string;
  readonly runAt: string | null;
  readonly missed?: {
    readonly firstMissedAt: string;
    readonly lastMissedAt: string;
    readonly missedCount: number;
  };
}

const CRON_GRACE_MS = 30_000;
const OCCURRENCES_PER_YIELD = 1_000;

function parseSchedule(schedule: string, from: Date) {
  return CronExpressionParser.parse(schedule, { currentDate: from, tz: "UTC" });
}

export async function advanceCronSchedule(input: {
  readonly firstDueAt: string;
  readonly intervalMs: number | null;
  readonly schedule: string | null;
  readonly now: Date;
}): Promise<CronAdvance | null> {
  const { firstDueAt, intervalMs, schedule, now } = input;
  const firstDue = Date.parse(firstDueAt);
  const nowMs = now.getTime();
  let latestDue = firstDue;
  let previousDue = firstDue;
  let dueCount = 1;
  let next: number;

  if (intervalMs !== null) {
    dueCount += Math.floor((nowMs - firstDue) / intervalMs);
    latestDue = firstDue + (dueCount - 1) * intervalMs;
    previousDue = latestDue - intervalMs;
    next = firstDue + dueCount * intervalMs;
  } else if (schedule !== null) {
    const expression = parseSchedule(schedule, new Date(firstDue));
    next = expression.next().getTime();
    while (next <= nowMs) {
      previousDue = latestDue;
      latestDue = next;
      dueCount++;
      next = expression.next().getTime();
      if (dueCount % OCCURRENCES_PER_YIELD === 0) await scheduler.yield();
    }
  } else {
    return null;
  }

  const withinGrace = nowMs - latestDue <= CRON_GRACE_MS;
  const missedCount = dueCount - (withinGrace ? 1 : 0);
  return {
    nextRunAt: new Date(next).toISOString(),
    runAt: withinGrace ? new Date(latestDue).toISOString() : null,
    ...(missedCount > 0
      ? {
          missed: {
            firstMissedAt: firstDueAt,
            lastMissedAt: new Date(withinGrace ? previousDue : latestDue).toISOString(),
            missedCount,
          },
        }
      : {}),
  };
}
