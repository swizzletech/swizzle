// The Overview's timetable as the page draws it. The API counts each automation's runs per hour;
// this module merges a pipeline's members into one line, decides how each hour draws, and puts the
// lines with a failure first.

import type { HourCounts, RunState, Timetable } from "./api";
import type { AutomationListItem } from "./pipeline-grouping";
import { RUN_TONE, type Tone } from "./words/health";

export const HOURS = 24;
const HOUR_MS = 60 * 60_000;

/** One list item's 24 hours and the deploys inside them, oldest first. */
export interface TimetableLine {
  readonly hours: readonly HourCounts[];
  readonly deployments: readonly { readonly at: string; readonly version: string }[];
}

/**
 * How one hour draws: nothing ran; a short bar in the tone of its runs; or, with any failure, a
 * full bar whose failed share is red and whose rest takes the tone of the other runs.
 */
export type HourCell =
  | { readonly kind: "empty" }
  | { readonly kind: "short"; readonly tone: Tone }
  | {
      readonly kind: "full";
      /** The failed runs' share of the hour, above 0 and at most 1. */
      readonly failed: number;
      /** Null when every run of the hour failed. */
      readonly rest: Tone | null;
    };

/** The tone a bar takes from the runs that did not fail: the first one present wins. */
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
  // A run counts toward a tone, so an hour without a failure has one.
  return { kind: "short", tone: rest ?? "idle" };
}

/** A line with no run and no deploy, for an automation the timetable does not name. */
const QUIET: TimetableLine = {
  deployments: [],
  hours: Array.from({ length: HOURS }, () => ({})),
};

/** The line of a list item: a pipeline adds up its members' runs and shows each one's deploys. */
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

/** The items with a failure in the window first, each keeping its place among its kind. */
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

/** When the hour at `index` starts. */
export function hourStart(timetable: Timetable, index: number): Date {
  return new Date(Date.parse(timetable.from) + index * HOUR_MS);
}

/**
 * Where a moment sits: the hour that holds it, counted from 0, plus how far into that hour it
 * falls, so 5.25 is a quarter past the start of the sixth hour.
 */
export function hoursInto(timetable: Timetable, iso: string): number {
  return (Date.parse(iso) - Date.parse(timetable.from)) / HOUR_MS;
}
