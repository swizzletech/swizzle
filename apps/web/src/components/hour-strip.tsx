import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import type { Timetable } from "../lib/api";
import { HOURS, hourCell, hourStart, hoursInto, type TimetableLine } from "../lib/timetable";
import { hourInWords, versionInWords } from "../lib/words/runs";
import { clockTime } from "../lib/words/time";
import "./hour-strip.css";

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

function markLeft(hours: number): string {
  const hour = Math.floor(hours);
  const within = hours - hour;
  return `calc((100% + var(--hour-gap)) * ${hour / HOURS} + ((100% + var(--hour-gap)) / ${HOURS} - var(--hour-gap)) * ${within})`;
}

function tipSide(index: number): string {
  if (index < 4) return "tip-start";
  return index >= HOURS - 4 ? "tip-end" : "";
}

function fullCell(failed: number, rest: string | null): CSSProperties {
  const edge = `max(4px, ${failed * 100}%)`;
  const top = rest === null ? "var(--fail)" : `var(--${rest === "run" ? "warn" : rest})`;
  return {
    background: `linear-gradient(to top, var(--fail) ${edge}, transparent ${edge}, transparent calc(${edge} + 2px), ${top} calc(${edge} + 2px))`,
  };
}
