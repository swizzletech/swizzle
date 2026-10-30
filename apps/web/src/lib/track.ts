// The track: one graph model the dashboard draws for a flow during a run and for a pipeline of
// automations. Pure functions build it from API records; `components/track.tsx` lays it out and
// draws it. Nothing here touches the DOM, so every rule about states, lanes and replay has a test.

import type { StepKind, StepSite } from "@swizzle/config/browser";

import { isOpenRun, type RunDetail, type RunStep } from "./api";
import { durationInWords } from "./words/time";

/** A step as the track knows it: from the steps read, or from a live step event. */
export type TrackStep = RunStep;

/** A flowchart as Mermaid parsed it, reduced to what the track needs. */
export interface FlowGraph {
  readonly direction: "TB" | "LR";
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
}

export interface FlowNode {
  readonly id: string;
  readonly label: string;
  readonly shape: "box" | "diamond" | "pill";
}

interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
}

/** A station's state during a run. `idle` is also the state of every station with no run. */
export type StationState = "idle" | "done" | "running" | "waiting" | "failed";

export type LaneState = "idle" | "done" | "active" | "untaken";

export interface TrackNode {
  readonly id: string;
  readonly label: string;
  /** The step key under the label; null for a narration node. */
  readonly key: string | null;
  readonly shape: FlowNode["shape"];
  readonly state: StationState;
  /** The duration or count beside the label, such as "0.4 s" or "12 of 50 runs". */
  readonly meta: string | null;
  /** Milliseconds the step took, for the duration bar beside a done station. */
  readonly durationMs: number | null;
  /** When the station reached its state, ms since the epoch; orders the done stations. */
  readonly at: number | null;
}

export interface TrackEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  readonly state: LaneState;
  /** A pipeline's invoke lane; chain lanes and flow lanes are solid. */
  readonly dashed: boolean;
}

export interface TrackGraph {
  readonly direction: FlowGraph["direction"];
  readonly nodes: readonly TrackNode[];
  readonly edges: readonly TrackEdge[];
}

/** What a run tells about each step, merged from the steps read and the live stream. */
export interface RunPosition {
  readonly steps: ReadonlyMap<string, TrackStep>;
  /** The step the run waits at, while it waits. */
  readonly waiting: WaitingStep | null;
}

export interface WaitingStep {
  readonly stepKey: string;
  readonly reason: NonNullable<RunDetail["wait"]>["reason"];
  /** Set when the wait is an approval the owner decides. */
  readonly approval: RunDetail["approval"];
  readonly until: string | null;
}

type RunFacts = Pick<RunDetail, "approval" | "status" | "wait">;

/** The wait the run is suspended at, from the run's own record. */
export function waitingStep(run: RunFacts): WaitingStep | null {
  if (run.status !== "waiting" || run.wait === null) return null;
  return {
    approval: run.approval,
    reason: run.wait.reason,
    stepKey: run.wait.stepKey,
    until: "until" in run.wait ? run.wait.until : null,
  };
}

/**
 * The station and lane states of a flow for one run. A node is a station when its id is a step
 * key the run recorded, or the step it waits at; every other node narrates. A narration node is
 * done when the run started and every lane into it is either taken (from a done node with no
 * other way out) or never coming (from a branch that left another way, or from a node behind
 * one), so a trigger lights at the start, a branch stays open until the run picks a side, and the
 * end of a flow lights however the run got there.
 */
export function trackForRun(
  flow: FlowGraph,
  run: Pick<RunDetail, "startedAt" | "status">,
  position: RunPosition,
  /** The step keys of the deployed code; a node named after one is a station even before the run reaches it. */
  stepKeys: ReadonlySet<string>,
): TrackGraph {
  const finished = !isOpenRun(run.status);
  const states = new Map<string, TrackNode>();
  const startOf = waitStarts(run, position);
  for (const node of flow.nodes) {
    states.set(node.id, stationFor(node, run, position, stepKeys, startOf));
  }
  const started = run.startedAt !== null;
  const outgoing = groupBy(flow.edges, (edge) => edge.from);
  const incoming = groupBy(flow.edges, (edge) => edge.to);
  // The run comes through this lane: its source is done and has no other way out.
  const taken = (lane: FlowEdge) =>
    states.get(lane.from)?.state === "done" && (outgoing.get(lane.from) ?? []).length === 1;
  // Evidence stays at recorded or waiting stations, even after narration becomes done.
  const stations: ReadonlyMap<string, TrackNode> = new Map(states);
  // The reached stations behind a node, found through narration; each node is visited once.
  const reachedBehind = (id: string): ReadonlyMap<string, number> => {
    const found = new Map<string, number>();
    const seen = new Set([id]);
    const queue = [id];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const lane of outgoing.get(next) ?? []) {
        const node = stations.get(lane.to);
        if (node === undefined || seen.has(lane.to)) continue;
        seen.add(lane.to);
        if (REACHED.has(node.state)) found.set(lane.to, node.at ?? 0);
        else if (node.key === null) queue.push(lane.to);
      }
    }
    return found;
  };
  const reachedBehindOrSelf = (id: string): ReadonlyMap<string, number> => {
    const node = stations.get(id);
    if (node === undefined) return new Map();
    if (REACHED.has(node.state)) return new Map([[id, node.at ?? 0]]);
    return node.key === null ? reachedBehind(id) : new Map();
  };
  const evidence: ReadonlyMap<FlowEdge, ReadonlyMap<string, number>> = new Map(
    flow.edges.map((lane) => {
      const siblings = (outgoing.get(lane.from) ?? []).filter((other) => other.to !== lane.to);
      const shared = new Set(
        siblings.flatMap((other) => [...reachedBehindOrSelf(other.to).keys()]),
      );
      return [
        lane,
        new Map([...reachedBehindOrSelf(lane.to)].filter(([key]) => !shared.has(key))),
      ] as const;
    }),
  );
  const evidenceAt: ReadonlyMap<FlowEdge, number | null> = new Map(
    [...evidence].map(([lane, found]) => [
      lane,
      found.size === 0 ? null : Math.min(...found.values()),
    ]),
  );
  // The run never comes through this lane: its source is dead, or a done branch that left another way.
  const dead = new Set<string>();
  const untaken = (lane: FlowEdge) =>
    dead.has(lane.from) ||
    (states.get(lane.from)?.state === "done" &&
      (outgoing.get(lane.from) ?? []).some(
        (other) =>
          (evidenceAt.get(other) ?? Number.POSITIVE_INFINITY) <
          (evidenceAt.get(lane) ?? Number.POSITIVE_INFINITY),
      ));
  // Only stations exclusive to each incoming lane can prove this narration was reached.
  const viaAt = (id: string): number | null => {
    let found = reachedBehind(id);
    for (const lane of incoming.get(id) ?? []) {
      found = new Map([...found].filter(([key]) => evidence.get(lane)?.has(key)));
    }
    return found.size === 0 ? null : Math.min(...found.values());
  };
  // Narration and death spread along lanes; a pass per rank is enough, bounded by the node count.
  for (let pass = 0; pass < flow.nodes.length; pass += 1) {
    let changed = false;
    for (const node of flow.nodes) {
      const current = states.get(node.id);
      if (current === undefined || current.state !== "idle" || dead.has(node.id)) continue;
      const lanes = incoming.get(node.id) ?? [];
      if (lanes.length > 0 && lanes.every(untaken)) {
        dead.add(node.id);
        changed = true;
        continue;
      }
      if (current.key !== null || !started) continue;
      const through = viaAt(node.id);
      if (through !== null) {
        states.set(node.id, { ...current, at: through, state: "done" });
        changed = true;
        continue;
      }
      const settled = lanes.every((lane) => taken(lane) || untaken(lane));
      if (!settled || (lanes.length > 0 && !lanes.some(taken))) continue;
      const at = Math.max(
        Date.parse(run.startedAt ?? "") || 0,
        ...lanes.filter(taken).map((lane) => states.get(lane.from)?.at ?? 0),
      );
      states.set(node.id, { ...current, at: at === 0 ? null : at, state: "done" });
      changed = true;
    }
    if (!changed) break;
  }
  const nodes = flow.nodes.map((node) => states.get(node.id) as TrackNode);
  return {
    direction: flow.direction,
    edges: lanesFor(flow.edges, states, finished, evidenceAt),
    nodes,
  };
}

/**
 * A wait (sleep, approval, event, child run) reports no start: the run suspended when it reached
 * it. It began when the step before it finished, or when the run started.
 */
function waitStarts(
  run: Pick<RunDetail, "startedAt">,
  position: RunPosition,
): (step: TrackStep) => number | null {
  const ends = [...position.steps.values()]
    .map((step) => (step.finishedAt === null ? null : Date.parse(step.finishedAt)))
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b);
  const runStart = Date.parse(run.startedAt ?? "") || null;
  return (step) => {
    if (step.startedAt !== null) return Date.parse(step.startedAt);
    if (step.finishedAt === null) return null;
    const end = Date.parse(step.finishedAt);
    const before = ends.filter((at) => at < end);
    return before.length === 0 ? runStart : (before[before.length - 1] as number);
  };
}

function stationFor(
  node: FlowNode,
  run: Pick<RunDetail, "status">,
  position: RunPosition,
  stepKeys: ReadonlySet<string>,
  startOf: (step: TrackStep) => number | null,
): TrackNode {
  const step = position.steps.get(node.id);
  const waiting = position.waiting?.stepKey === node.id ? position.waiting : null;
  const key = node.id;
  const base = {
    at: null,
    durationMs: null,
    id: node.id,
    key: stepKeys.has(node.id) ? key : null,
    label: node.label,
    meta: null,
    shape: node.shape,
    state: "idle" as const,
  };
  if (step === undefined && waiting === null) return base;
  if (waiting !== null && (step === undefined || step.finishedAt === null)) {
    return { ...base, key, meta: waitingInWords(waiting), state: "waiting" };
  }
  if (step === undefined) return { ...base, key };
  if (step.finishedAt !== null) {
    const start = startOf(step);
    const durationMs = start === null ? null : Date.parse(step.finishedAt) - start;
    return {
      ...base,
      at: Date.parse(step.finishedAt),
      durationMs,
      key,
      meta: durationMs === null ? null : durationInWords(durationMs),
      state: "done",
    };
  }
  // Started and not finished: the run is in it, or its attempt died in it.
  const at = step.startedAt === null ? null : Date.parse(step.startedAt);
  if (run.status === "running") return { ...base, at, key, state: "running" };
  return { ...base, at, key, meta: "did not finish", state: "failed" };
}

function waitingInWords(waiting: WaitingStep): string {
  if (waiting.approval !== null) return "waiting for approval";
  if (waiting.reason === "sleep") return "sleeping";
  if (waiting.reason === "child") return "waiting for child runs";
  return "waiting for an event";
}

const REACHED = new Set<StationState>(["done", "running", "waiting", "failed"]);

/**
 * A lane is done between two reached stations, active into the station the run is in, and
 * untaken when the run left its source another way, or ended without reaching its target. Where
 * recorded stations distinguish a branch, its earliest exclusive station identifies the lane.
 * Shared stations leave the branch open, regardless of derived narration states.
 */
function lanesFor(
  edges: readonly FlowEdge[],
  states: ReadonlyMap<string, TrackNode>,
  finished: boolean,
  evidenceAt: ReadonlyMap<FlowEdge, number | null>,
): readonly TrackEdge[] {
  const outgoing = groupBy(edges, (edge) => edge.from);
  const reachedAt = (edge: FlowEdge) => evidenceAt.get(edge) ?? Number.POSITIVE_INFINITY;
  return edges.map((edge) => {
    const from = states.get(edge.from)?.state ?? "idle";
    const to = states.get(edge.to)?.state ?? "idle";
    const siblings = (outgoing.get(edge.from) ?? []).filter(
      (other) => other !== edge && evidenceAt.get(other) !== null,
    );
    let state: LaneState = "idle";
    const branch = (outgoing.get(edge.from) ?? []).length > 1;
    if (from === "done" && siblings.some((other) => reachedAt(other) < reachedAt(edge))) {
      state = "untaken";
    } else if (from === "done" && REACHED.has(to) && (!branch || evidenceAt.get(edge) !== null)) {
      state = to === "done" ? "done" : "active";
    } else if (
      from === "done" &&
      to === "idle" &&
      // A branch with no side reached yet is open, even when the run is over: nothing says which
      // way it went. Only a run that ended on a single way out left that lane untaken.
      ((finished && (outgoing.get(edge.from) ?? []).length === 1) || siblings.length > 0)
    ) {
      state = "untaken";
    }
    return { dashed: false, from: edge.from, label: edge.label, state, to: edge.to };
  });
}

/** Every station idle, with how many of the last runs reached each step beside its label. */
export function staticTrack(
  flow: FlowGraph,
  stepKeys: ReadonlySet<string>,
  reach: { readonly runs: number; readonly reached: Readonly<Record<string, number>> } | null,
): TrackGraph {
  return {
    direction: flow.direction,
    edges: flow.edges.map((edge) => ({ ...edge, dashed: false, state: "idle" as const })),
    nodes: flow.nodes.map((node) => {
      const key = stepKeys.has(node.id) ? node.id : null;
      const meta =
        key !== null && reach !== null && reach.runs > 0
          ? `${reach.reached[key] ?? 0} of ${reach.runs} ${reach.runs === 1 ? "run" : "runs"}`
          : null;
      return {
        at: null,
        durationMs: null,
        id: node.id,
        key,
        label: node.label,
        meta,
        shape: node.shape,
        state: "idle",
      };
    }),
  };
}

/** The step whose code the Play tab shows in colour: running, waiting or failed, else the last done. */
export function activeStep(track: TrackGraph): string | null {
  const stations = track.nodes.filter((node) => node.key !== null);
  for (const state of ["running", "waiting", "failed"] as const) {
    const station = stations.find((node) => node.state === state);
    if (station !== undefined) return station.key;
  }
  const done = stations.filter((node) => node.state === "done");
  const last = done.reduce<TrackNode | null>(
    (latest, node) => (latest === null || (node.at ?? 0) >= (latest.at ?? 0) ? node : latest),
    null,
  );
  return last?.key ?? null;
}

// Replay: a finished run's step and wait spans on a compressed clock, so a two-day approval takes a
// second to watch. `positionAt` turns a point on that clock back into station states.

interface ReplaySpan {
  readonly kind: "step" | "wait";
  readonly key: string;
  /** Real time, ms since the run started. */
  readonly from: number;
  readonly to: number;
  /** Compressed playback time, ms since the start of the replay. */
  readonly playFrom: number;
  readonly playTo: number;
}

export interface Replay {
  readonly spans: readonly ReplaySpan[];
  /** Compressed playback length in ms. */
  readonly length: number;
  readonly compressed: boolean;
  /** The run's start, ms since the epoch, which the spans count from. */
  readonly startedAt: number;
}

/** The longest a span or the gap before it plays; what takes longer is compressed to this. */
const SPAN_PLAY_MS = 1_500;
const GAP_PLAY_MS = 400;
/** The shortest a span plays, so a 3 ms step is still seen. */
const SPAN_PLAY_MIN_MS = 350;

const WAIT_KINDS = new Set<StepSite["kind"]>(["sleep", "child", "event", "approval"]);

/**
 * The run's steps in the order they finished. A step that reported its start spans its own time;
 * a wait, which has no start, spans from the previous step's end to its resume.
 */
export function buildReplay(
  run: Pick<RunDetail, "startedAt" | "finishedAt">,
  steps: readonly TrackStep[],
  sites: readonly StepSite[],
): Replay {
  const startedAt = Date.parse(run.startedAt ?? "") || 0;
  const kinds = new Map(sites.map((site) => [site.key, site.kind]));
  const finishedSteps = steps
    .filter((step) => step.finishedAt !== null)
    .sort((a, b) => Date.parse(a.finishedAt ?? "") - Date.parse(b.finishedAt ?? ""));
  const spans: ReplaySpan[] = [];
  let realCursor = 0;
  let playCursor = 0;
  let compressed = false;
  for (const step of finishedSteps) {
    const to = Date.parse(step.finishedAt ?? "") - startedAt;
    const kind = WAIT_KINDS.has(kinds.get(step.stepKey) ?? "step") ? "wait" : "step";
    const from =
      step.startedAt === null || kind === "wait"
        ? realCursor
        : Math.max(realCursor, Date.parse(step.startedAt) - startedAt);
    const gap = from - realCursor;
    if (gap > GAP_PLAY_MS) compressed = true;
    playCursor += Math.min(gap, GAP_PLAY_MS);
    const real = Math.max(0, to - from);
    const play = Math.min(Math.max(real, SPAN_PLAY_MIN_MS), SPAN_PLAY_MS);
    if (real > SPAN_PLAY_MS) compressed = true;
    spans.push({
      from,
      key: step.stepKey,
      kind,
      playFrom: playCursor,
      playTo: playCursor + play,
      to,
    });
    playCursor += play;
    realCursor = Math.max(realCursor, to);
  }
  const end = run.finishedAt === null ? realCursor : Date.parse(run.finishedAt) - startedAt;
  const tail = Math.max(0, end - realCursor);
  if (tail > GAP_PLAY_MS) compressed = true;
  return { compressed, length: playCursor + Math.min(tail, GAP_PLAY_MS), spans, startedAt };
}

/** The wait reason a replayed step stands for, by the kind of its call site. */
const WAIT_REASON: Partial<Record<StepKind, WaitingStep["reason"]>> = {
  approval: "approval",
  child: "child",
  event: "event",
  sleep: "sleep",
};

/** The run as it looked at `playMs` of the replay: done, running and waiting steps at that moment. */
export function positionAt(
  replay: Replay,
  playMs: number,
  sites: readonly StepSite[],
): RunPosition {
  const steps = new Map<string, TrackStep>();
  let waiting: WaitingStep | null = null;
  const kinds = new Map(sites.map((site) => [site.key, site.kind]));
  for (const span of replay.spans) {
    if (span.playFrom > playMs) continue;
    const startedAt = new Date(replay.startedAt + span.from).toISOString();
    const open = span.playTo > playMs;
    const finishedAt = open ? null : new Date(replay.startedAt + span.to).toISOString();
    steps.set(span.key, {
      approval: null,
      attempt: 1,
      executionNumber: 1,
      createdAt: startedAt,
      finishedAt,
      startedAt: span.kind === "wait" ? null : startedAt,
      stepKey: span.key,
      updatedAt: finishedAt ?? startedAt,
      value: null,
    });
    if (open && span.kind === "wait") {
      const kind = kinds.get(span.key);
      waiting = {
        approval:
          kind === "approval"
            ? {
                assignee: null,
                details: null,
                may: { decide: false, reassign: false },
                stepKey: span.key,
              }
            : null,
        reason: WAIT_REASON[kind ?? "event"] ?? "event",
        stepKey: span.key,
        until: null,
      };
    }
  }
  return { steps, waiting };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
