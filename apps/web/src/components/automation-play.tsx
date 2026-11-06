// Automation Play: the deployed code of a run beside its track. The step the run is in reads in
// full colour, the rest greys out, and every step's lines carry a bracket and a tag in the state's
// colour. An open run follows the worker live; a finished run replays on a compressed clock, so a
// two-day approval passes in a second and a half, and a run that looped over items replays one
// pass per item. The item counter under the track reads the same live, in the replay and at its
// end, where a failed run names the item it died in. A step's code and its station meet through
// the step family (`stepFamily`). Display only: nothing here edits code.

import { type StepKind, type StepSite, stepFamily } from "@swizzle/config/browser";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { type AutomationDetail, isOpenRun, type RunDetail, type RunListItem } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import {
  activeStep,
  buildReplay,
  type ItemPass,
  positionAt,
  type Replay,
  type RunPosition,
  replayPass,
  runPass,
  staticTrack,
  type TrackGraph,
  type TrackNode,
  trackForRun,
} from "../lib/track";
import { type AutomationFlow, useAutomationFlow } from "../lib/use-automation-flow";
import { useRunPosition } from "../lib/use-run-track";
import { assigneeInWords, runStatusInWords } from "../lib/words/runs";
import { ageInWords, durationInWords } from "../lib/words/time";
import { ApprovalActions } from "./actions";
import { approvalOnStation, DriftNote } from "./flow-track";
import { StationFace, Track } from "./track";
import { Dot, ErrorNote, Skeleton, useNow } from "./ui";
import "./automation-play.css";

export function AutomationPlay(props: {
  readonly automation: AutomationDetail;
  readonly runId: string | undefined;
  readonly onSelectRun: (runId: string) => void;
}) {
  const { api, queryScope } = useDashboardClient();
  const slug = props.automation.automationSlug;
  const runsQuery = useQuery({
    queryFn: () => api.listRuns({ automation: slug, limit: 25 }),
    queryKey: ["runs", "automation", slug, ...queryScope],
    refetchInterval: 5_000,
  });
  const runs = runsQuery.data?.runs ?? [];
  const selected = props.runId ?? runs[0]?.runId;
  const runQuery = useQuery({
    enabled: selected !== undefined,
    queryFn: () => api.getRunDetail(selected ?? ""),
    queryKey: ["run", selected, ...queryScope],
    refetchInterval: (query) =>
      query.state.data !== undefined && isOpenRun(query.state.data.status) ? 3_000 : false,
  });
  const run = runQuery.data ?? null;
  const flow = useAutomationFlow(
    slug,
    run?.deploymentId ?? props.automation.activeDeployment.deploymentId,
  );

  if (runQuery.isError) {
    return <ErrorNote error={runQuery.error} title="This run could not be loaded." />;
  }
  if (flow.sourceError !== null) {
    return (
      <ErrorNote
        error={flow.sourceError}
        onRetry={flow.refetchSource}
        title="The deployed code could not be loaded."
      />
    );
  }
  if (flow.pending || (selected !== undefined && run === null) || flow.source === null) {
    return (
      <div className="card">
        <Skeleton label="Loading the code" lines={6} />
      </div>
    );
  }
  if (flow.source.content === null) {
    return (
      <ErrorNote
        error={flow.source.error ?? "The entrypoint could not be read."}
        title="The deployed code could not be read."
      />
    );
  }
  return (
    <div className="play" data-testid="play">
      <div className="play-head">
        <RunPicker onSelect={props.onSelectRun} runs={runs} selected={selected} />
        <PlayState run={run} />
        <DriftNote flow={flow} />
      </div>
      {run === null ? (
        <StaticPlay flow={flow} source={flow.source.content} />
      ) : isOpenRun(run.status) ? (
        <LivePlay flow={flow} key={run.runId} run={run} source={flow.source.content} />
      ) : (
        <ReplayPlay flow={flow} key={run.runId} run={run} source={flow.source.content} />
      )}
    </div>
  );
}

/** Whether the code reads as deployed, follows a live run, or replays a finished one. */
function PlayState({ run }: { readonly run: RunDetail | null }) {
  if (run === null) return <span className="t-meta">No run selected: the code as deployed.</span>;
  if (!isOpenRun(run.status)) return null;
  return (
    <span className="t-meta inline-flex items-center gap-2">
      <Dot tone="run" /> Live
    </span>
  );
}

function RunPicker(props: {
  readonly onSelect: (runId: string) => void;
  readonly runs: readonly RunListItem[];
  readonly selected: string | undefined;
}) {
  const now = useNow();
  if (props.runs.length === 0) return <span className="t-meta">No runs yet.</span>;
  return (
    <label className="play-pick t-meta">
      Run
      <select
        aria-label="Run"
        className="field"
        onChange={(event) => props.onSelect(event.target.value)}
        value={props.selected ?? ""}
      >
        {props.runs.map((run) => (
          <option key={run.runId} value={run.runId}>
            {run.runId.slice(0, 8)} · {runStatusInWords(run)} · {ageInWords(run.queuedAt, now)}
          </option>
        ))}
      </select>
    </label>
  );
}

function StaticPlay(props: { readonly flow: AutomationFlow; readonly source: string }) {
  const track =
    props.flow.graph === null
      ? null
      : staticTrack(props.flow.graph, props.flow.families, props.flow.reach);
  return (
    <PlayBody
      active={null}
      approval={null}
      flow={props.flow}
      source={props.source}
      track={track}
      transport={null}
    />
  );
}

function LivePlay(props: {
  readonly flow: AutomationFlow;
  readonly run: RunDetail;
  readonly source: string;
}) {
  const { position } = useRunPosition(props.run);
  const pass = runPass(position, props.flow.families);
  const track =
    props.flow.graph === null
      ? null
      : trackForRun(props.flow.graph, props.run, position, props.flow.families, pass);
  return (
    <PlayBody
      active={track === null ? liveActive(position) : activeStep(track)}
      approval={props.run.approval === null ? null : props.run}
      flow={props.flow}
      source={props.source}
      track={track}
      transport={
        pass === null ? null : (
          <div className="play-transport" data-testid="play-transport">
            <ItemCounter items={null} pass={pass} />
          </div>
        )
      }
    />
  );
}

/** Without a flowchart there is no track to ask; the newest started step's family is the active one. */
function liveActive(position: RunPosition): string | null {
  if (position.waiting !== null) return stepFamily(position.waiting.stepKey);
  let latest: { key: string; at: number } | null = null;
  for (const step of position.steps.values()) {
    const at = Date.parse(step.finishedAt ?? step.startedAt ?? "") || 0;
    if (latest === null || at >= latest.at) latest = { at, key: step.stepKey };
  }
  return latest === null ? null : stepFamily(latest.key);
}

function ReplayPlay(props: {
  readonly flow: AutomationFlow;
  readonly run: RunDetail;
  readonly source: string;
}) {
  const { position: final, ready, steps } = useRunPosition(props.run);
  const replay = useMemo(
    () => buildReplay(props.run, steps, props.flow.sites),
    [props.run, steps, props.flow.sites],
  );
  // The clock lives in a ref as well as in state: the frame loop reads the ref, so a frame that
  // fires after the end cannot restart a finished replay from the stale state it closed over.
  const [playMs, setPlayMs] = useState<number | null>(null);
  const clock = useRef<number | null>(null);
  const setClock = (ms: number | null) => {
    clock.current = ms;
    setPlayMs(ms);
  };
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = (clock.current ?? 0) + (now - last);
      last = now;
      if (next >= replay.length) {
        clock.current = null;
        setPlayMs(null);
        setPlaying(false);
        return;
      }
      clock.current = next;
      setPlayMs(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, replay.length]);

  if (!ready) {
    return (
      <div className="card">
        <Skeleton label="Loading the steps" lines={4} />
      </div>
    );
  }
  // At the end the run's own record shows, with every duration exact: a succeeded run all its
  // items together, any other the item it ended in.
  const atEnd = playMs === null;
  const position = atEnd ? final : positionAt(replay, playMs, props.flow.sites);
  const pass = !atEnd
    ? replayPass(replay, playMs)
    : props.run.status === "succeeded"
      ? null
      : runPass(final, props.flow.families);
  const track =
    props.flow.graph === null
      ? null
      : trackForRun(
          props.flow.graph,
          atEnd ? props.run : { startedAt: props.run.startedAt, status: "running" },
          position,
          props.flow.families,
          pass,
        );
  const transport = (
    <Transport
      onPlay={() => {
        if (atEnd) setClock(0);
        setPlaying(true);
      }}
      onPause={() => setPlaying(false)}
      onSeek={(ms) => {
        setPlaying(false);
        setClock(ms >= replay.length ? null : ms);
      }}
      pass={pass}
      playMs={playMs ?? replay.length}
      playing={playing}
      replay={replay}
    />
  );
  return (
    <PlayBody
      active={track === null ? liveActive(position) : activeStep(track)}
      approval={null}
      flow={props.flow}
      source={props.source}
      track={track}
      transport={transport}
    />
  );
}

/**
 * Play, pause and a scrubber over the replay's compressed clock, with the real time it stands for,
 * the item counter when the run looped, and a line when the run did no step.
 */
function Transport(props: {
  readonly onPause: () => void;
  readonly onPlay: () => void;
  readonly onSeek: (ms: number) => void;
  readonly pass: ItemPass | null;
  readonly playMs: number;
  readonly playing: boolean;
  readonly replay: Replay;
}) {
  const { replay } = props;
  return (
    <div className="play-transport" data-testid="play-transport">
      <button
        aria-label={props.playing ? "Pause" : "Play"}
        className="btn small"
        onClick={props.playing ? props.onPause : props.onPlay}
        type="button"
      >
        {props.playing ? "❙❙" : "▶"}
      </button>
      <input
        aria-label="Replay position"
        max={replay.length}
        min={0}
        onChange={(event) => props.onSeek(Number(event.target.value))}
        step={10}
        type="range"
        value={props.playMs}
      />
      <span className="t-faint whitespace-nowrap">
        {durationInWords(realTimeAt(replay, props.playMs))} in
        {replay.compressed ? " · waits compressed" : ""}
      </span>
      <ItemCounter items={replay.items.length} pass={props.pass} />
      {replay.didNoStep ? (
        <span className="t-meta" data-testid="play-no-steps">
          This run did no step.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The item a looping run is on, "Item 37 of 200" with its id, or "Item 37" while the total is
 * unknown; without a current item, how many items the run did. Nothing for a run that named none.
 */
function ItemCounter(props: { readonly items: number | null; readonly pass: ItemPass | null }) {
  const { pass } = props;
  if (pass === null && (props.items ?? 0) === 0) return null;
  return (
    <span className="play-pass t-meta" data-testid="play-pass">
      {pass === null
        ? `${props.items} ${props.items === 1 ? "item" : "items"}`
        : `Item ${pass.index}${pass.of === null ? "" : ` of ${pass.of}`}`}
      {pass === null ? null : <code title={pass.item}>{pass.item}</code>}
    </span>
  );
}

/** The run time a point of the replay clock stands for. */
function realTimeAt(replay: Replay, playMs: number): number {
  let real = 0;
  for (const span of replay.spans) {
    if (playMs >= span.playTo) {
      real = span.to;
      continue;
    }
    if (playMs >= span.playFrom) {
      const share = (playMs - span.playFrom) / Math.max(1, span.playTo - span.playFrom);
      return span.from + share * (span.to - span.from);
    }
    break;
  }
  return real;
}

const KIND_WORDS: Record<StepKind, string> = {
  approval: "approval",
  child: "child run",
  event: "event",
  sleep: "sleep",
  step: "step",
};

function tagWords(site: StepSite, station: TrackNode | undefined): string {
  if (station?.state === "untaken") return "not taken";
  if (station === undefined || station.state === "idle") return KIND_WORDS[site.kind];
  if (station.state === "done") {
    return station.meta === null ? "done" : `done · ${station.meta}`;
  }
  return station.meta ?? station.state;
}

/** The rail, the code and, on the phone, the pinned step and the bars at the bottom. */
function PlayBody(props: {
  readonly active: string | null;
  /** The run waiting at an approval, for the phone's Approve and Reject bar. */
  readonly approval: RunDetail | null;
  readonly flow: AutomationFlow;
  readonly source: string;
  readonly track: TrackGraph | null;
  readonly transport: ReactNode;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  // A click pins a step until the run moves on; the code then follows the run to its new step.
  useEffect(() => {
    setFocus(null);
    if (props.active !== null) scrollToStep(props.active);
  }, [props.active]);
  const shown = focus ?? props.active;
  const stations = new Map(
    (props.track?.nodes ?? []).flatMap((node) => (node.key === null ? [] : [[node.key, node]])),
  );
  const select = (node: TrackNode) => {
    if (node.key === null) return;
    setFocus(node.key);
    scrollToStep(node.key);
  };
  const pinned = shown === null ? null : stations.get(shown);
  return (
    <div className="play-body">
      {pinned === undefined || pinned === null ? null : (
        <div className="play-pin" data-testid="play-pin">
          <span className={`dot ${PIN_TONE[pinned.state]}`} />
          <b>{pinned.label}</b>
          <span className="t-meta" title={pinned.meta ?? undefined}>
            {pinned.meta ?? pinned.state}
          </span>
        </div>
      )}
      <CodePane
        active={shown}
        flow={props.flow}
        onSelect={select}
        source={props.source}
        stations={stations}
      />
      {props.track === null ? null : (
        <aside className="play-rail" data-testid="play-rail">
          <Track
            direction="TB"
            extra={(node) =>
              props.approval === null ? null : approvalOnStation(node, props.approval)
            }
            focused={shown}
            onSelect={select}
            testId="play-track"
            track={props.track}
          />
          {props.transport === null ? null : <div className="play-rail-bar">{props.transport}</div>}
        </aside>
      )}
      {props.track === null && props.transport !== null ? (
        <div className="play-transport-row">{props.transport}</div>
      ) : null}
      <div className="play-bars">
        {props.transport === null ? null : <div className="play-bar">{props.transport}</div>}
        {props.approval?.approval === null || props.approval === null ? null : (
          <div className="play-bar play-approve" data-testid="play-approve">
            <span className="t-meta">
              Asks: <b>{props.approval.approval.stepKey}</b>
              {props.approval.approval.assignee === null
                ? null
                : ` · assigned to ${assigneeInWords(props.approval.approval.assignee)}`}
            </span>
            <ApprovalActions
              may={props.approval.approval.may}
              runId={props.approval.runId}
              stepKey={props.approval.approval.stepKey}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function scrollToStep(key: string): void {
  document
    .getElementById(`play-step-${key}`)
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}

const PIN_TONE: Record<TrackNode["state"], string> = {
  done: "ok",
  failed: "fail",
  idle: "idle",
  running: "run",
  untaken: "idle",
  waiting: "warn",
};

function CodePane(props: {
  readonly active: string | null;
  readonly flow: AutomationFlow;
  readonly onSelect: (node: TrackNode) => void;
  readonly source: string;
  readonly stations: ReadonlyMap<string, TrackNode>;
}) {
  const lines = props.source.split("\n");
  const sites = props.flow.sites;
  // The first call of each family is where a click on its station scrolls to.
  const anchors = new Map<string, number>();
  for (const site of sites) {
    if (!anchors.has(stepFamily(site.key))) anchors.set(stepFamily(site.key), site.startLine);
  }
  // The innermost site that spans a line owns it, so a step nested in a step keeps its own bracket.
  const siteAt = (line: number): StepSite | undefined =>
    sites
      .filter((site) => site.startLine <= line && line <= site.endLine)
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  return (
    <pre
      className={`play-code ${props.active === null ? "" : "has-active"}`}
      data-testid="play-code"
    >
      {lines.map((text, index) => {
        const line = index + 1;
        const site = siteAt(line);
        const family = site === undefined ? null : stepFamily(site.key);
        const station = family === null ? undefined : props.stations.get(family);
        const state = station?.state ?? "idle";
        const first = site?.startLine === line;
        const classes = [
          "pl",
          site === undefined ? "" : `in-step ${state}`,
          family !== null && family === props.active ? "focus" : "",
          first ? "first" : "",
          site?.endLine === line ? "last" : "",
        ].join(" ");
        return (
          <div className="contents" key={line}>
            {first && site !== undefined ? (
              <div className="play-inline">
                <StationCard onSelect={props.onSelect} site={site} station={station} />
              </div>
            ) : null}
            <div
              className={classes}
              data-step={site?.key}
              id={first && anchors.get(family ?? "") === line ? `play-step-${family}` : undefined}
            >
              <span className="ln">{line}</span>
              <span className="code">{text}</span>
              {first && site !== undefined ? (
                <span className={`tag ${state}`} title={tagWords(site, station)}>
                  {tagWords(site, station)}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </pre>
  );
}

/** The station as a card above its code on the phone, where there is no room for a rail. */
function StationCard(props: {
  readonly onSelect: (node: TrackNode) => void;
  readonly site: StepSite;
  readonly station: TrackNode | undefined;
}) {
  const { station } = props;
  const state = station?.state ?? "idle";
  return (
    <button
      className={`station card st-card ${state}`}
      data-state={state}
      data-step={props.site.key}
      onClick={() => station && props.onSelect(station)}
      type="button"
    >
      <StationFace
        label={station?.label ?? props.site.key}
        meta={tagWords(props.site, station)}
        state={state}
      />
    </button>
  );
}
