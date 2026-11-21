import type { HourCounts, RunState, Timetable } from "./api";
import type { AutomationListItem } from "./pipeline-grouping";
import { RUN_TONE, type Tone } from "./words/health";

export const HOURS = 24;
const HOUR_MS = 60 * 60_000;

export interface TimetableLine {
  readonly hours: readonly HourCounts[];
  readonly deployments: readonly { readonly at: string; readonly version: string }[];
}

export type HourCell =
  | { readonly kind: "empty" }
  | { readonly kind: "short"; readonly tone: Tone }
  | {
      readonly kind: "full";
      readonly failed: number;
      readonly rest: Tone | null;
    };

const REST_TONES: readonly Tone[] = ["ok", "run", "warn", "idle"];

export function hourCell(counts: HourCounts): HourCell {
  const byTone = new Map<Tone, number>();
  let total = 0;
  for (const [state, count] of Object.entries(counts) as [RunState, number][]) {
    byTone.set(RUN_TONE[state], (byTone.get(RUN_TONE[state]) ?? 0) + count);
    total += count;
  }
  if (total === 0) return { kind: "empty" };
  const rest = REST_TONES.find((tone) => (byTone.get(tone) ?? 0) > 0) ?? null;
  const failed = byTone.get("fail") ?? 0;
  if (failed > 0) return { failed: failed / total, kind: "full", rest };
  return { kind: "short", tone: rest ?? "idle" };
}

const QUIET: TimetableLine = {
  deployments: [],
  hours: Array.from({ length: HOURS }, () => ({})),
};

function lineOf(item: AutomationListItem, timetable: Timetable): TimetableLine {
  const slugs = new Set(
    (item.kind === "group" ? item.members : [item.automation]).map((one) => one.automationSlug),
  );
  const rows = timetable.rows.filter((row) => slugs.has(row.automationSlug));
  if (rows.length === 0) return QUIET;
  return {
    deployments: rows
      .flatMap((row) => row.deployments)
      .toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at)),
    hours: Array.from({ length: HOURS }, (_, hour) => {
      const sum: Partial<Record<RunState, number>> = {};
      for (const row of rows) {
        for (const [state, count] of Object.entries(row.hours[hour] ?? {}) as [
          RunState,
          number,
        ][]) {
          sum[state] = (sum[state] ?? 0) + count;
        }
      }
      return sum;
    }),
  };
}

export function failingFirst(
  items: readonly AutomationListItem[],
  timetable: Timetable,
): readonly { readonly item: AutomationListItem; readonly line: TimetableLine }[] {
  const lines = items.map((item) => ({ item, line: lineOf(item, timetable) }));
  const failing = (line: TimetableLine) =>
    line.hours.some((hour) => hourCell(hour).kind === "full");
  return [
    ...lines.filter(({ line }) => failing(line)),
    ...lines.filter(({ line }) => !failing(line)),
  ];
}

export function hourStart(timetable: Timetable, index: number): Date {
  return new Date(Date.parse(timetable.from) + index * HOUR_MS);
}

export function hoursInto(timetable: Timetable, iso: string): number {
  return (Date.parse(iso) - Date.parse(timetable.from)) / HOUR_MS;
}
