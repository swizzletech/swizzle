// One automation's last 24 hours on the Overview: a cell per hour, oldest left, and above it a
// mark with the version of each deploy at its time. `HourAxis` is the header above the strips.
// lib/timetable.ts decides how an hour draws; the hover names the hour and its counts.

import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import type { Timetable } from "../lib/api";
import { HOURS, hourCell, hourStart, hoursInto, type TimetableLine } from "../lib/timetable";
import { hourInWords, versionInWords } from "../lib/words/runs";
import { clockTime } from "../lib/words/time";
import "./hour-strip.css";

/** The hours the axis names; "now" closes it at the right edge. */
const AXIS_HOURS = [0, 6, 12, 18];

export function HourAxis(props: { readonly timetable: Timetable }) {
  return (
    <span aria-hidden="true" className="hour-axis">
      {AXIS_HOURS.map((hour) => (
        <span key={hour}>{clockTime(hourStart(props.timetable, hour))}</span>
      ))}
      <span className="now">now</span>
    </span>
  );
}

/** The strip opens the automation's runs, so a click on an hour leads to the runs it counts. */
export function HourStrip(props: {
  readonly automationSlug: string;
  readonly line: TimetableLine;
  readonly timetable: Timetable;
}) {
  const { line, timetable } = props;
  const failed = line.hours.filter((hour) => hourCell(hour).kind === "full").length;
  return (
    <Link
      aria-label={
        failed === 0 ? "Last 24 hours, no failure" : `Last 24 hours, ${failed} with a failure`
      }
      className="hour-strip"
      params={{ automationSlug: props.automationSlug }}
      search={{ tab: "runs" }}
      tabIndex={-1}
      to="/automations/$automationSlug"
    >
      {line.deployments.map((deployment) => (
        <span
          className="hour-mark"
          key={deployment.at}
          style={{ left: markLeft(hoursInto(timetable, deployment.at)) }}
        >
          {versionInWords(deployment.version)}
        </span>
      ))}
      <span className="hour-cells">
        {line.hours.map((counts, index) => {
          const cell = hourCell(counts);
          return (
            <i
              className={`${cell.kind} ${cell.kind === "short" ? cell.tone : ""} ${tipSide(index)}`}
              data-tip={hourInWords(hourStart(timetable, index), counts)}
              // biome-ignore lint/suspicious/noArrayIndexKey: an hour is its position
              key={index}
              style={cell.kind === "full" ? fullCell(cell.failed, cell.rest) : undefined}
            />
          );
        })}
      </span>
    </Link>
  );
}

/**
 * A mark's left edge inside the hour cell that holds its moment. The cells sit in a grid with a
 * gap between them, so a column and its gap take (100% + gap) / 24 and a cell that less the gap.
 */
function markLeft(hours: number): string {
  const hour = Math.floor(hours);
  const within = hours - hour;
  return `calc((100% + var(--hour-gap)) * ${hour / HOURS} + ((100% + var(--hour-gap)) / ${HOURS} - var(--hour-gap)) * ${within})`;
}

/** The hover sits over its hour, and inside the strip at its two ends. */
function tipSide(index: number): string {
  if (index < 4) return "tip-start";
  return index >= HOURS - 4 ? "tip-end" : "";
}

/**
 * The failed share in red at the foot, at least 4 px so one failure among many shows, then a 2 px
 * gap and the rest in the tone of the other runs.
 */
function fullCell(failed: number, rest: string | null): CSSProperties {
  const edge = `max(4px, ${failed * 100}%)`;
  const top = rest === null ? "var(--fail)" : `var(--${rest === "run" ? "warn" : rest})`;
  return {
    background: `linear-gradient(to top, var(--fail) ${edge}, transparent ${edge}, transparent calc(${edge} + 2px), ${top} calc(${edge} + 2px))`,
  };
}
