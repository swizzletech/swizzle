import type { DashboardTimetable, TimetableClock, TimetableWindow } from "./dashboard-types.js";
import { RUN_STATES, type RunState } from "./run-status.js";

const HOUR_MS = 60 * 60_000;
export const TIMETABLE_HOURS = 24;

export function timetableWindow(clock: TimetableClock): TimetableWindow {
  const offsetMs = clock.utcOffsetMinutes * 60_000;
  const hourStart = Math.floor((clock.now.getTime() + offsetMs) / HOUR_MS) * HOUR_MS - offsetMs;
  return {
    from: new Date(hourStart - (TIMETABLE_HOURS - 1) * HOUR_MS),
    until: new Date(hourStart + HOUR_MS),
  };
}

export function countTimetable(timetable: DashboardTimetable): Record<RunState, number> {
  const counts: Record<RunState, number> = {
    cancelled: 0,
    "dead-lettered": 0,
    failed: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    waiting: 0,
  };
  for (const hour of timetable.rows.flatMap((row) => row.hours)) {
    for (const state of RUN_STATES) counts[state] += hour[state] ?? 0;
  }
  return counts;
}
