import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

import type { RunListItem } from "../lib/api";
import type { RunPages } from "../lib/use-run-pages";
import { RUN_TONE, type Tone } from "../lib/words/health";
import { runCountInWords, runRowInWords } from "../lib/words/runs";
import { clockTime, dayInWords } from "../lib/words/time";
import { ActionError } from "./actions";
import { Dot, ErrorNote, Skeleton, useNow, usePhone } from "./ui";
import "./run-workbench.css";

export interface RunSplitView {
  readonly selected: string | undefined;
  readonly list: boolean;
  readonly run: string | undefined;
}

export function useRunSplit(opened: string | undefined, first: string | undefined): RunSplitView {
  const phone = usePhone();
  const selected = opened ?? first;
  return {
    list: !phone || opened === undefined,
    run: !phone || opened !== undefined ? selected : undefined,
    selected,
  };
}

export function RunWorkbench(props: {
  readonly pages: RunPages;
  readonly view: RunSplitView;
  readonly leads: "automation" | "state";
  readonly empty: string;
  readonly onSelect: (runId: string, options?: { readonly replace: boolean }) => void;
  readonly onBack: () => void;
  readonly band?: ReactNode;
  readonly listEnd?: ReactNode;
  readonly run: (runId: string) => ReactNode;
}) {
  const { view } = props;
  return (
    <div className="work" data-testid="run-workbench">
      {view.list ? (
        <div className="pane" data-testid="run-list-pane">
          <RunList {...props} />
        </div>
      ) : null}
      {view.run === undefined ? (
        <div className="pane pane-empty">
          <p className="t-meta">No run to show</p>
        </div>
      ) : (
        <div className="pane" data-testid="run-pane">
          {view.list ? (
            props.band
          ) : (
            <div className="work-back">
              <button className="btn quiet small" onClick={props.onBack} type="button">
                ← All runs
              </button>
            </div>
          )}
          {props.run(view.run)}
          {view.list ? null : props.band}
        </div>
      )}
    </div>
  );
}

function RunList(props: {
  readonly pages: RunPages;
  readonly view: RunSplitView;
  readonly leads: "automation" | "state";
  readonly empty: string;
  readonly onSelect: (runId: string, options?: { readonly replace: boolean }) => void;
  readonly listEnd?: ReactNode;
}) {
  const { pages, view } = props;
  const { selected } = view;
  const now = useNow();
  const rows = useRef<HTMLDivElement | null>(null);
  const runs = pages.runs;
  const loaded = runs !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` scrolls once the rows exist
  useEffect(() => {
    rows.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, loaded]);

  if (pages.error !== null) {
    return (
      <div className="pane-note">
        <ErrorNote error={pages.error} onRetry={pages.retry} title="The runs could not be loaded" />
      </div>
    );
  }
  if (runs === undefined) return <Skeleton label="Loading runs" lines={6} />;
  if (runs.length === 0) return <p className="pane-note t-meta">{props.empty}</p>;

  const tabStop = runs.some((run) => run.runId === selected) ? selected : runs[0]?.runId;
  const beside = view.list && view.run !== undefined;
  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!beside || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const at = runs.findIndex((run) => run.runId === selected);
    const next = runs[Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1))];
    if (next === undefined) return;
    event.currentTarget
      .querySelector<HTMLElement>(`[data-run-id="${next.runId}"]`)
      ?.focus({ preventScroll: true });
    props.onSelect(next.runId, { replace: true });
  };

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the keys reach the row's own button */}
      <div data-testid="run-list" onKeyDown={walk} ref={rows}>
        {runsByDay(runs, now).map((day) => (
          <section aria-label={day.name} key={day.key}>
            <h2 className="day">
              <span>{day.name}</span>
              <span className="day-date">{day.date}</span>
            </h2>
            {day.runs.map((run) => (
              <RunRow
                key={run.runId}
                leads={props.leads}
                onSelect={props.onSelect}
                run={run}
                selected={run.runId === selected}
                tabStop={run.runId === tabStop}
              />
            ))}
          </section>
        ))}
      </div>
      <div className="list-end">
        {pages.complete ? null : (
          <button
            className="btn quiet small"
            disabled={pages.loadingOlder}
            onClick={pages.loadOlder}
            type="button"
          >
            {pages.loadingOlder ? "Loading…" : "Load older runs"}
          </button>
        )}
        {pages.olderError === null ? null : <ActionError error={pages.olderError} />}
        <span className="t-faint" data-testid="run-count">
          {pages.complete
            ? `${runCountInWords(runs.length, true)}, that is all of them`
            : `${runCountInWords(runs.length, false)} runs loaded`}
        </span>
        {props.listEnd}
      </div>
    </>
  );
}

function runsByDay(runs: readonly RunListItem[], now: Date) {
  const days: { key: string; name: string; date: string; runs: RunListItem[] }[] = [];
  for (const run of runs) {
    const key = new Date(run.queuedAt).toDateString();
    const last = days.at(-1);
    if (last?.key === key) last.runs.push(run);
    else days.push({ ...dayInWords(run.queuedAt, now), key, runs: [run] });
  }
  return days;
}

const LINE_CLASS: Record<Tone, string> = {
  fail: "failline",
  idle: "",
  ok: "",
  run: "",
  warn: "warnline",
};

function RunRow(props: {
  readonly leads: "automation" | "state";
  readonly onSelect: (runId: string) => void;
  readonly run: RunListItem;
  readonly selected: boolean;
  readonly tabStop: boolean;
}) {
  const { run } = props;
  const tone = RUN_TONE[run.state];
  const words = runRowInWords(run, props.leads);
  return (
    <button
      aria-current={props.selected}
      className="rrow"
      data-run-id={run.runId}
      data-testid="run-row"
      onClick={() => props.onSelect(run.runId)}
      tabIndex={props.tabStop ? 0 : -1}
      type="button"
    >
      <Dot tone={tone} />
      <span className="rrow-text">
        <span className="rrow-title">{words.title}</span>
        <span className={`rrow-line ${LINE_CLASS[tone]}`}>{words.line}</span>
      </span>
      <time className="rrow-time" dateTime={run.queuedAt}>
        {clockTime(new Date(run.queuedAt))}
      </time>
    </button>
  );
}
