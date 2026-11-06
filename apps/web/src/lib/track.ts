// The track: one graph model the dashboard draws for a flow during a run and for a pipeline of
// automations. Pure functions build it from API records; `components/track.tsx` lays it out and
// draws it. Nothing here touches the DOM, so every rule about states, lanes and replay has a test.

import { type StepKind, type StepSite, stepFamily, stepItem } from "@swizzle/config/browser";

import { isOpenRun, type RunDetail, type RunStep } from "./api";
import { durationInWords } from "./words/time";

/** A step as the track knows it: from the steps read, or from a live step event. */
export type TrackStep = RunStep;

/** A flowchart as Mermaid parsed it, reduced to what the track needs. */
export interface FlowGraph {
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

/**
 * A station's state during a run. `idle` is also the state of every station with no run;
 * `untaken` is a station the run can no longer reach, because every lane into it was not taken.
 */
export type StationState = "idle" | "done" | "running" | "waiting" | "failed" | "untaken";

export type LaneState = "idle" | "done" | "active" | "untaken";

export interface TrackNode {
  readonly id: string;
  readonly label: string;
  /** The step family the station stands for, which is its id; null for a narration node. */
  readonly key: string | null;
  readonly shape: FlowNode["shape"];
  readonly state: StationState;
  /** The duration, count or item under the label, such as "0.4 s", "12 of 50 runs" or "failed at item 37 · INV-37". */
  readonly meta: string | null;
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
  readonly nodes: readonly TrackNode[];
  readonly edges: readonly TrackEdge[];
}

/** What a run tells about each step, merged from the steps read and the live stream. */
export interface RunPosition {
  /** By step key; every key of one family lights the family's station. */
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
 * Which item a run that loops is on: the item id after the family (`stepItem`), its 1-based place
 * among the items in the order they started, and how many items the run did in all. That total is
 * known only for a run that succeeded, because a run records only the items it reached, so `of`
 * is null while a run is open and after it failed.
 */
export interface ItemPass {
  readonly item: string;
  readonly index: number;
  readonly of: number | null;
}

/** "item 37 of 200", or "item 37" while the total is unknown. */
function itemInWords(pass: ItemPass): string {
  return pass.of === null ? `item ${pass.index}` : `item ${pass.index} of ${pass.of}`;
}

/**
 * The item a real run is on or ended in: the item of its wait, else of the open item step that
 * started last (where a failed run died), else of the item step that started last. Only a family
 * the code calls names items, so the SDK's `claim:<key>` steps never count.
 */
export function runPass(position: RunPosition, families: ReadonlySet<string>): ItemPass | null {
  const itemOf = (key: string) => (families.has(stepFamily(key)) ? stepItem(key) : null);
  const firstStart = new Map<string, number>();
  let open: { item: string; at: number } | null = null;
  let last: { item: string; at: number } | null = null;
  for (const step of position.steps.values()) {
    const item = itemOf(step.stepKey);
    if (item === null) continue;
    const at = Date.parse(step.startedAt ?? step.createdAt);
    firstStart.set(item, Math.min(firstStart.get(item) ?? at, at));
    if (last === null || at >= last.at) last = { at, item };
    if (step.finishedAt === null && (open === null || at >= open.at)) open = { at, item };
  }
  const waited = position.waiting === null ? null : itemOf(position.waiting.stepKey);
  const item = waited ?? open?.item ?? last?.item ?? null;
  if (item === null) return null;
  const order = [...firstStart].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  return { index: order.indexOf(item) + 1, item, of: null };
}

/**
 * The station and lane states of a flow for one run. A node is a station when its id is the
 * family of a step the run recorded or waits at (`stepFamily`); every other node narrates. A run
 * that looped over items shows them all together once it succeeded, and otherwise only the steps
 * of `pass`, the item it is on or ended in, so a later family never looks done from an earlier
 * item. A replay names its own pass; a real run's comes from `runPass`. A narration node is
 * done when the run started and every lane into it is either taken (from a done node with no
 * other way out) or never coming (from a branch that left another way, or from a node behind
 * one), so a trigger lights at the start, a branch stays open until the run picks a side, and the
 * end of a flow lights however the run got there.
 */
export function trackForRun(
  flow: FlowGraph,
  run: Pick<RunDetail, "startedAt" | "status">,
  recorded: RunPosition,
  /** The step families of the deployed code; a node named after one is a station even before the run reaches it. */
  families: ReadonlySet<string>,
  pass: ItemPass | null = runPass(recorded, families),
): TrackGraph {
  const shown = run.status === "succeeded" ? null : pass;
  const position = onePass(recorded, families, shown);
  const finished = !isOpenRun(run.status);
  const states = new Map<string, TrackNode>();
  const startOf = waitStarts(run, position);
  const byFamily = groupBy([...position.steps.values()], (step) => stepFamily(step.stepKey));
  for (const node of flow.nodes) {
    states.set(
      node.id,
      stationFor(
        node,
        run,
        byFamily.get(node.id) ?? [],
        position.waiting,
        families,
        startOf,
        shown,
      ),
    );
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
  return markUntaken({
    edges: lanesFor(flow.edges, states, finished, evidenceAt),
    nodes: flow.nodes.map((node) => states.get(node.id) as TrackNode),
  });
}

/** The steps without an item, and of those that name one, only `pass`'s; every step when null. */
function onePass(
  position: RunPosition,
  families: ReadonlySet<string>,
  pass: ItemPass | null,
): RunPosition {
  if (pass === null) return position;
  const itemOf = (key: string) => (families.has(stepFamily(key)) ? stepItem(key) : null);
  const steps = [...position.steps].filter(([key]) => [null, pass.item].includes(itemOf(key)));
  return { ...position, steps: new Map(steps) };
}

/**
 * An idle node whose every lane in is untaken can no longer be reached, so it is untaken and so are
 * its lanes out. Spreads along lanes, one pass per rank at most.
 */
function markUntaken(track: TrackGraph): TrackGraph {
  let { edges, nodes } = track;
  for (let pass = 0; pass < nodes.length; pass += 1) {
    const incoming = groupBy(edges, (edge) => edge.to);
    const cut = new Set(
      nodes
        .filter((node) => node.state === "idle")
        .filter((node) => {
          const lanes = incoming.get(node.id) ?? [];
          return lanes.length > 0 && lanes.every((lane) => lane.state === "untaken");
        })
        .map((node) => node.id),
    );
    if (cut.size === 0) break;
    nodes = nodes.map((node) => (cut.has(node.id) ? { ...node, state: "untaken" } : node));
    edges = edges.map((edge) => (cut.has(edge.from) ? { ...edge, state: "untaken" } : edge));
  }
  return { ...track, edges, nodes };
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

/**
 * One station from the steps of its family. A family that ran for several items is in the state
 * of its open item, or done when every item finished, with the items' summed time. A station whose
 * open step is `pass`'s item names that item: "item 37 · INV-37", or "failed at item 37 · INV-37".
 */
function stationFor(
  node: FlowNode,
  run: Pick<RunDetail, "status">,
  steps: readonly TrackStep[],
  runWaiting: WaitingStep | null,
  families: ReadonlySet<string>,
  startOf: (step: TrackStep) => number | null,
  pass: ItemPass | null,
): TrackNode {
  const waitingHere = runWaiting !== null && stepFamily(runWaiting.stepKey) === node.id;
  const waiting = waitingHere ? runWaiting : null;
  const key = node.id;
  const base = {
    at: null,
    id: node.id,
    key: families.has(node.id) ? key : null,
    label: node.label,
    meta: null,
    shape: node.shape,
    state: "idle" as const,
  };
  const waitedStep = steps.find((step) => step.stepKey === waiting?.stepKey);
  if (waiting !== null && (waitedStep === undefined || waitedStep.finishedAt === null)) {
    return { ...base, key, meta: waitingInWords(waiting), state: "waiting" };
  }
  if (steps.length === 0) return base;
  const items = steps.length > 1 ? `${steps.length} items` : null;
  // Started and not finished: the run is in it, or its attempt died in it.
  const open = steps.find((step) => step.finishedAt === null);
  if (open !== undefined) {
    const at = open.startedAt === null ? null : Date.parse(open.startedAt);
    const item =
      pass !== null && stepItem(open.stepKey) === pass.item
        ? `${itemInWords(pass)} · ${pass.item}`
        : null;
    if (run.status === "running")
      return { ...base, at, key, meta: item ?? items, state: "running" };
    const meta = item === null ? "did not finish" : `failed at ${item}`;
    return { ...base, at, key, meta, state: "failed" };
  }
  const ends = steps.map((step) => Date.parse(step.finishedAt ?? ""));
  const spans = steps.map((step) => {
    const start = startOf(step);
    return start === null ? null : Date.parse(step.finishedAt ?? "") - start;
  });
  const duration = spans.includes(null)
    ? null
    : durationInWords(spans.reduce<number>((sum, span) => sum + (span ?? 0), 0));
  return {
    ...base,
    at: Math.max(...ends),
    key,
    meta: [items, duration].filter((part) => part !== null).join(" · ") || null,
    state: "done",
  };
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

/** Every station idle, with how many of the last runs reached each step family beside its label. */
export function staticTrack(
  flow: FlowGraph,
  families: ReadonlySet<string>,
  reach: { readonly runs: number; readonly reached: Readonly<Record<string, number>> } | null,
): TrackGraph {
  return {
    edges: flow.edges.map((edge) => ({ ...edge, dashed: false, state: "idle" as const })),
    nodes: flow.nodes.map((node) => {
      const key = families.has(node.id) ? node.id : null;
      const meta =
        key !== null && reach !== null && reach.runs > 0
          ? `${reach.reached[key] ?? 0} of ${reach.runs} ${reach.runs === 1 ? "run" : "runs"}`
          : null;
      return {
        at: null,
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

/** The step family whose code the Play tab shows in colour: running, waiting or failed, else the last done. */
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
// second to watch. A run that looped over items replays one pass per item: the steps of a family
// the code calls whose key names an item (`upload:INV-1`, see `stepItem`) play together, in the
// order the items started, and
// each pass lights the stations of its own item alone (`replayPass`, handed to `trackForRun`). A
// step without an item keeps its place in time. `positionAt` turns a point on that clock back into
// the steps done, running and waiting by then.

interface ReplaySpan {
  readonly kind: "step" | "wait";
  readonly key: string;
  /** The item the key names after its family (`stepItem`); null for a step that runs once. */
  readonly item: string | null;
  /** Real time, ms since the run started. */
  readonly from: number;
  readonly to: number;
  /** Compressed playback time, ms since the start of the replay. */
  readonly playFrom: number;
  readonly playTo: number;
}

export interface Replay {
  /** In playback order: by item pass, then by the order the steps finished. */
  readonly spans: readonly ReplaySpan[];
  /** Compressed playback length in ms. */
  readonly length: number;
  readonly compressed: boolean;
  /** The run's start, ms since the epoch, which the spans count from. */
  readonly startedAt: number;
  /** The items the run's steps named, in the order they started; one replay pass each. */
  readonly items: readonly string[];
  /** Whether the run succeeded, so `items` is every item it did and the counter can say "of". */
  readonly succeeded: boolean;
  /**
   * Whether the run recorded no step at all. A run whose first step started and failed, or was
   * canceled or timed out in it, has no span to play either, but it did a step.
   */
  readonly didNoStep: boolean;
}

/** The longest a span or the gap before it plays; what takes longer is compressed to this. */
const SPAN_PLAY_MS = 1_500;
const GAP_PLAY_MS = 400;
/** The shortest a span plays, so a 3 ms step is still seen. */
const SPAN_PLAY_MIN_MS = 350;
/** How long a run that recorded no step plays: long enough to see its trigger light. */
const EMPTY_PLAY_MS = 1_000;

const WAIT_KINDS = new Set<StepSite["kind"]>(["sleep", "child", "event", "approval"]);

/**
 * A span in real time, before it gets its place on the playback clock. `started` is when the run
 * recorded the step starting, unclamped: it orders and numbers the item passes, so items that
 * overlap play in the order they started even when a later one finished first.
 */
type RealSpan = Omit<ReplaySpan, "playFrom" | "playTo"> & { readonly started: number };

/**
 * The run's finished steps on the replay clock. A step that reported its start spans its own time;
 * a wait, which has no start, spans from the previous step's end to its resume.
 */
export function buildReplay(
  run: Pick<RunDetail, "startedAt" | "finishedAt" | "status">,
  steps: readonly TrackStep[],
  sites: readonly StepSite[],
): Replay {
  const startedAt = Date.parse(run.startedAt ?? "") || 0;
  const kinds = kindsByFamily(sites);
  const finishedSteps = steps
    .filter((step) => step.finishedAt !== null)
    .sort((a, b) => Date.parse(a.finishedAt ?? "") - Date.parse(b.finishedAt ?? ""));
  const real: RealSpan[] = [];
  let finishedCursor = 0;
  for (const step of finishedSteps) {
    const to = Date.parse(step.finishedAt ?? "") - startedAt;
    const kind = WAIT_KINDS.has(kinds.get(stepFamily(step.stepKey)) ?? "step") ? "wait" : "step";
    const from =
      step.startedAt === null || kind === "wait"
        ? finishedCursor
        : Math.max(finishedCursor, Date.parse(step.startedAt) - startedAt);
    // Only a family the code calls makes passes; a claim's `claim:<key>` names no item of the loop.
    const item = kinds.has(stepFamily(step.stepKey)) ? stepItem(step.stepKey) : null;
    // A wait reports no start; its row is written when the run reached it. `runPass` counts the same way.
    const started = Date.parse(step.startedAt ?? step.createdAt) - startedAt;
    real.push({ from, item, key: step.stepKey, kind, started, to });
    finishedCursor = Math.max(finishedCursor, to);
  }
  const ordered = byItemPass(real);
  const spans: ReplaySpan[] = [];
  let realCursor = 0;
  let playCursor = 0;
  let compressed = false;
  for (const { started: _, ...span } of ordered) {
    const gap = Math.max(0, span.from - realCursor);
    if (gap > GAP_PLAY_MS) compressed = true;
    playCursor += Math.min(gap, GAP_PLAY_MS);
    const realMs = Math.max(0, span.to - span.from);
    const play = Math.min(Math.max(realMs, SPAN_PLAY_MIN_MS), SPAN_PLAY_MS);
    if (realMs > SPAN_PLAY_MS) compressed = true;
    spans.push({ ...span, playFrom: playCursor, playTo: playCursor + play });
    playCursor += play;
    realCursor = Math.max(realCursor, span.to);
  }
  const end = run.finishedAt === null ? realCursor : Date.parse(run.finishedAt) - startedAt;
  const tail = Math.max(0, end - realCursor);
  if (tail > GAP_PLAY_MS) compressed = true;
  const length = playCursor + Math.min(tail, GAP_PLAY_MS);
  return {
    compressed,
    didNoStep: steps.length === 0,
    items: [...new Set(ordered.flatMap((span) => (span.item === null ? [] : [span.item])))],
    length: spans.length === 0 ? Math.max(length, EMPTY_PLAY_MS) : length,
    spans,
    startedAt,
    succeeded: run.status === "succeeded",
  };
}

/**
 * The spans in playback order: an item's steps together, where its first step started; a step
 * without an item where it started. Both by the recorded start, never the clamped `from`. Within a
 * group the steps keep the order they finished in.
 */
function byItemPass(spans: readonly RealSpan[]): readonly RealSpan[] {
  const groups: { at: number; spans: RealSpan[] }[] = [];
  const passes = new Map<string, { at: number; spans: RealSpan[] }>();
  for (const span of spans) {
    const pass = span.item === null ? undefined : passes.get(span.item);
    if (pass !== undefined) {
      pass.spans.push(span);
      pass.at = Math.min(pass.at, span.started);
      continue;
    }
    const group = { at: span.started, spans: [span] };
    if (span.item !== null) passes.set(span.item, group);
    groups.push(group);
  }
  return groups.sort((a, b) => a.at - b.at).flatMap((group) => group.spans);
}

/** The pass at `playMs`: the item of the last item step started by then; null before the first. */
export function replayPass(replay: Replay, playMs: number): ItemPass | null {
  let item: string | null = null;
  for (const span of replay.spans) {
    if (span.playFrom > playMs) break;
    if (span.item !== null) item = span.item;
  }
  if (item === null) return null;
  return {
    index: replay.items.indexOf(item) + 1,
    item,
    of: replay.succeeded ? replay.items.length : null,
  };
}

/** The wait reason a replayed step stands for, by the kind of its call site. */
const WAIT_REASON: Partial<Record<StepKind, WaitingStep["reason"]>> = {
  approval: "approval",
  child: "child",
  event: "event",
  sleep: "sleep",
};

/**
 * The run as it looked at `playMs` of the replay: done, running and waiting steps at that moment.
 * `trackForRun` with `replayPass` at the same point shows only the current item's, so each item
 * lights its stations anew.
 */
export function positionAt(
  replay: Replay,
  playMs: number,
  sites: readonly StepSite[],
): RunPosition {
  const steps = new Map<string, TrackStep>();
  let waiting: WaitingStep | null = null;
  const kinds = kindsByFamily(sites);
  for (const span of replay.spans) {
    if (span.playFrom > playMs) break;
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
      const kind = kinds.get(stepFamily(span.key));
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

/** What each step family waits for, from its first call site. */
function kindsByFamily(sites: readonly StepSite[]): ReadonlyMap<string, StepKind> {
  const kinds = new Map<string, StepKind>();
  for (const site of sites) {
    const family = stepFamily(site.key);
    if (!kinds.has(family)) kinds.set(family, site.kind);
  }
  return kinds;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
