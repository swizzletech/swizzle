import { type StepKind, type StepSite, stepFamily, stepItem } from "@swizzle/config/browser";

import { isOpenRun, type RunDetail, type RunStep } from "./api";
import { durationInWords } from "./words/time";

export type TrackStep = RunStep;

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

export type StationState = "idle" | "done" | "running" | "waiting" | "failed" | "untaken";

export type LaneState = "idle" | "done" | "active" | "untaken";

export interface TrackNode {
  readonly id: string;
  readonly label: string;
  readonly key: string | null;
  readonly shape: FlowNode["shape"];
  readonly state: StationState;
  readonly meta: string | null;
  readonly at: number | null;
}

export interface TrackEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  readonly state: LaneState;
  readonly dashed: boolean;
}

export interface TrackGraph {
  readonly nodes: readonly TrackNode[];
  readonly edges: readonly TrackEdge[];
}

export interface RunPosition {
  readonly steps: ReadonlyMap<string, TrackStep>;
  readonly waiting: WaitingStep | null;
}

export interface WaitingStep {
  readonly stepKey: string;
  readonly reason: NonNullable<RunDetail["wait"]>["reason"];
  readonly approval: RunDetail["approval"];
  readonly until: string | null;
}

type RunFacts = Pick<RunDetail, "approval" | "status" | "wait">;

export function waitingStep(run: RunFacts): WaitingStep | null {
  if (run.status !== "waiting" || run.wait === null) return null;
  return {
    approval: run.approval,
    reason: run.wait.reason,
    stepKey: run.wait.stepKey,
    until: "until" in run.wait ? run.wait.until : null,
  };
}

export interface ItemPass {
  readonly item: string;
  readonly index: number;
  readonly of: number | null;
}

function itemInWords(pass: ItemPass): string {
  return pass.of === null ? `item ${pass.index}` : `item ${pass.index} of ${pass.of}`;
}

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

export function trackForRun(
  flow: FlowGraph,
  run: Pick<RunDetail, "startedAt" | "status">,
  recorded: RunPosition,
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
  const taken = (lane: FlowEdge) =>
    states.get(lane.from)?.state === "done" && (outgoing.get(lane.from) ?? []).length === 1;
  const stations: ReadonlyMap<string, TrackNode> = new Map(states);
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
  const dead = new Set<string>();
  const untaken = (lane: FlowEdge) =>
    dead.has(lane.from) ||
    (states.get(lane.from)?.state === "done" &&
      (outgoing.get(lane.from) ?? []).some(
        (other) =>
          (evidenceAt.get(other) ?? Number.POSITIVE_INFINITY) <
          (evidenceAt.get(lane) ?? Number.POSITIVE_INFINITY),
      ));
  const viaAt = (id: string): number | null => {
    let found = reachedBehind(id);
    for (const lane of incoming.get(id) ?? []) {
      found = new Map([...found].filter(([key]) => evidence.get(lane)?.has(key)));
    }
    return found.size === 0 ? null : Math.min(...found.values());
  };
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
      ((finished && (outgoing.get(edge.from) ?? []).length === 1) || siblings.length > 0)
    ) {
      state = "untaken";
    }
    return { dashed: false, from: edge.from, label: edge.label, state, to: edge.to };
  });
}

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

interface ReplaySpan {
  readonly kind: "step" | "wait";
  readonly key: string;
  readonly item: string | null;
  readonly from: number;
  readonly to: number;
  readonly playFrom: number;
  readonly playTo: number;
}

export interface Replay {
  readonly spans: readonly ReplaySpan[];
  readonly length: number;
  readonly compressed: boolean;
  readonly startedAt: number;
  readonly items: readonly string[];
  readonly succeeded: boolean;
  readonly didNoStep: boolean;
}

const SPAN_PLAY_MS = 1_500;
const GAP_PLAY_MS = 400;
const SPAN_PLAY_MIN_MS = 350;
const EMPTY_PLAY_MS = 1_000;

const WAIT_KINDS = new Set<StepSite["kind"]>(["sleep", "child", "event", "approval"]);

type RealSpan = Omit<ReplaySpan, "playFrom" | "playTo"> & { readonly started: number };

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
    const item = kinds.has(stepFamily(step.stepKey)) ? stepItem(step.stepKey) : null;
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

const WAIT_REASON: Partial<Record<StepKind, WaitingStep["reason"]>> = {
  approval: "approval",
  child: "child",
  event: "event",
  sleep: "sleep",
};

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
