import { type ReactNode, useEffect, useState } from "react";

import type { LaneState, StationState, TrackEdge, TrackGraph, TrackNode } from "../lib/track";
import { TrackView } from "./track-view";
import { ErrorNote, usePhone } from "./ui";
import "./track.css";

interface Placed {
  readonly node: TrackNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Routed {
  readonly edge: TrackEdge;
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly label: { readonly x: number; readonly y: number } | null;
}

interface Layout {
  readonly width: number;
  readonly height: number;
  readonly stations: readonly Placed[];
  readonly lanes: readonly Routed[];
}

type Dagre = {
  readonly Graph: typeof import("dagre-d3-es/src/graphlib/index.js").Graph;
  readonly layout: typeof import("dagre-d3-es/src/dagre/index.js").layout;
};

let dagreModule: Promise<Dagre> | null = null;

function dagre(): Promise<Dagre> {
  dagreModule ??= Promise.all([
    import("dagre-d3-es/src/graphlib/index.js"),
    import("dagre-d3-es/src/dagre/index.js"),
    document.fonts.load(sansFont(CARD_TYPE)).catch(() => []),
    document.fonts.load(sansFont(MARK_TYPE)).catch(() => []),
  ])
    .then(([graphlib, layout]) => ({ Graph: graphlib.Graph, layout: layout.layout }))
    .catch((error: unknown) => {
      dagreModule = null;
      throw error;
    });
  return dagreModule;
}

function loadDagre(onLoaded: (lib: Dagre) => void, onError: (message: string) => void): void {
  dagre().then(onLoaded, (error: unknown) => {
    onError(error instanceof Error ? error.message : String(error));
  });
}

type TrackDirection = "LR" | "TB";

export interface StationExtra {
  readonly height: number;
  readonly width: number;
}

const LABEL_LINES = 3;
const LABEL_STEP = 8;
const CARD_TYPE = "500 13px";
const CARD_TEXT_MIN = 84;
const CARD_TEXT_MAX = 132;
const CARD_CHROME = 52;
const CARD_FRAME = 18;
const CARD_LINE = 20;
const CARD_META = 16;
const MARK_TYPE = "500 12px";
const MARK_TEXT_MIN = 76;
const MARK_TEXT_MAX = 124;
const MARK_CHROME = 32;
const MARK_DIAMOND = 16;
const MARK_LINE = 16;

const ruler = document.createElement("canvas").getContext("2d");

function sansFont(type: string): string {
  return `${type} ${getComputedStyle(document.documentElement).getPropertyValue("--font-sans")}`;
}

function wrappedLines(words: readonly number[], space: number, column: number): number {
  let lines = 1;
  let used = 0;
  for (const word of words) {
    if (used > 0 && used + space + word > column) {
      lines += 1;
      used = 0;
    }
    lines += Math.max(Math.ceil(word / column) - 1, 0);
    used += (used > 0 ? space : 0) + (word > column ? word % column : word);
  }
  return lines;
}

function labelColumn(label: string, type: string, min: number, max: number) {
  if (ruler === null) return { column: max, lines: LABEL_LINES };
  ruler.font = sansFont(type);
  const widthOf = (text: string) => ruler.measureText(text).width;
  const words = label.split(/\s+/u).map(widthOf);
  const space = widthOf(" ");
  let column = Math.min(Math.max(min, Math.ceil(Math.max(...words))), max);
  while (column < max && wrappedLines(words, space, column) > LABEL_LINES) column += LABEL_STEP;
  column = Math.min(column, Math.ceil(widthOf(label)));
  return { column, lines: wrappedLines(words, space, column) };
}

function stationSize(node: TrackNode, extra: StationExtra | null) {
  if (node.key === null) {
    const { column, lines } = labelColumn(node.label, MARK_TYPE, MARK_TEXT_MIN, MARK_TEXT_MAX);
    const chrome = MARK_CHROME + (node.shape === "diamond" ? MARK_DIAMOND : 0);
    return { height: 24 + (lines - 1) * MARK_LINE, width: column + chrome };
  }
  const { column, lines } = labelColumn(node.label, CARD_TYPE, CARD_TEXT_MIN, CARD_TEXT_MAX);
  const width = Math.max(Math.max(column, CARD_TEXT_MIN) + CARD_CHROME, extra?.width ?? 0);
  return { height: CARD_FRAME + lines * CARD_LINE + CARD_META + (extra?.height ?? 0), width };
}

function layoutTrack(
  lib: Dagre,
  track: TrackGraph,
  direction: TrackDirection,
  extras: ReadonlyMap<string, StationExtra>,
): Layout {
  const graph = new lib.Graph({ multigraph: true })
    .setGraph({
      edgesep: 8,
      marginx: 4,
      marginy: 4,
      nodesep: 12,
      rankdir: direction,
      ranksep: 16,
    })
    .setDefaultEdgeLabel(() => ({}));
  for (const node of track.nodes) {
    graph.setNode(node.id, stationSize(node, extras.get(node.id) ?? null));
  }
  track.edges.forEach((edge, index) => {
    const label = edge.label ?? "";
    graph.setEdge(
      edge.from,
      edge.to,
      {
        height: label === "" ? 0 : 16,
        labelpos: "c",
        width: label === "" ? 0 : label.length * 7 + 8,
      },
      `lane-${index}`,
    );
  });
  lib.layout(graph, {});
  const size = graph.graph() as { readonly width?: number; readonly height?: number };
  const stations = track.nodes.map((node) => {
    const placed = graph.node(node.id) as { x: number; y: number; width: number; height: number };
    return { height: placed.height, node, width: placed.width, x: placed.x, y: placed.y };
  });
  const lanes = track.edges.map((edge, index) => {
    const routed = graph.edge({ name: `lane-${index}`, v: edge.from, w: edge.to }) as {
      points: { x: number; y: number }[];
      x?: number;
      y?: number;
    };
    return {
      edge,
      label:
        edge.label === null || routed.x === undefined || routed.y === undefined
          ? null
          : { x: routed.x, y: routed.y },
      points: routed.points,
    };
  });
  return { height: size.height ?? 0, lanes, stations, width: size.width ?? 0 };
}

function lanePath(points: readonly { readonly x: number; readonly y: number }[]): string {
  const [first, ...rest] = points;
  if (first === undefined) return "";
  if (rest.length < 2)
    return `M${first.x} ${first.y} ${rest.map((p) => `L${p.x} ${p.y}`).join(" ")}`;
  let path = `M${first.x} ${first.y}`;
  let previous = first;
  for (let index = 0; index < rest.length - 1; index += 1) {
    const corner = rest[index] as { x: number; y: number };
    const next = rest[index + 1] as { x: number; y: number };
    const mid = { x: (corner.x + next.x) / 2, y: (corner.y + next.y) / 2 };
    path += ` Q${corner.x} ${corner.y} ${mid.x} ${mid.y}`;
    previous = mid;
  }
  const last = rest[rest.length - 1] as { x: number; y: number };
  if (previous.x !== last.x || previous.y !== last.y) path += ` L${last.x} ${last.y}`;
  return path;
}

const STATE_WORDS: Record<StationState, string> = {
  done: "done",
  failed: "failed",
  idle: "",
  running: "running",
  untaken: "not taken",
  waiting: "waiting",
};

const STATE_SYMBOL: Record<StationState, ReactNode> = {
  done: <path className="st-mark" d="M5 9.2 7.8 12 13 6.6" />,
  failed: <path className="st-mark" d="M6.2 6.2 11.8 11.8 M11.8 6.2 6.2 11.8" />,
  idle: null,
  running: <path className="st-mark" d="M9 1a8 8 0 0 1 8 8" />,
  untaken: null,
  waiting: <path className="st-mark" d="M9 5.6V9l2.4 1.6" />,
};

export function StationFace(props: {
  readonly label: string;
  readonly meta: string | null;
  readonly state: StationState;
}) {
  return (
    <>
      <svg aria-hidden="true" className={`st-sym ${props.state}`} viewBox="0 0 18 18">
        <circle cx="9" cy="9" r="8" />
        {STATE_SYMBOL[props.state]}
      </svg>
      <span className="st-text">
        <span className="st-label">{props.label}</span>
        <span className="st-meta" title={props.meta ?? undefined}>
          {props.meta}
        </span>
      </span>
    </>
  );
}

const LANE_CLASS: Record<LaneState, string> = {
  active: "active",
  done: "done",
  idle: "",
  untaken: "untaken",
};

export function Track(props: {
  readonly track: TrackGraph;
  readonly direction?: TrackDirection;
  readonly extra?: (
    node: TrackNode,
  ) => { readonly content: ReactNode; readonly size: StationExtra } | null;
  readonly focused?: string | null;
  readonly onSelect?: (node: TrackNode) => void;
  readonly testId?: string;
}) {
  const { track } = props;
  const phone = usePhone();
  const direction = props.direction ?? (phone ? "TB" : "LR");
  const [lib, setLib] = useState<Dagre | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    loadDagre(setLib, setLoadError);
  }, []);
  if (loadError !== null) {
    return (
      <ErrorNote
        error={loadError}
        onRetry={() => {
          setLoadError(null);
          loadDagre(setLib, setLoadError);
        }}
        title="The track could not be drawn"
      />
    );
  }
  if (lib === null) {
    return <div aria-busy="true" className="track-wait skeleton" data-testid={props.testId} />;
  }

  const extras = new Map<string, { content: ReactNode; size: StationExtra }>();
  for (const node of track.nodes) {
    const extra = props.extra?.(node);
    if (extra) extras.set(node.id, extra);
  }
  const layout = layoutTrack(
    lib,
    track,
    direction,
    new Map([...extras].map(([id, extra]) => [id, extra.size])),
  );

  return (
    <TrackView focused={props.focused ?? null}>
      <div
        className="track"
        data-direction={direction}
        data-testid={props.testId}
        style={{ height: layout.height, width: layout.width }}
      >
        <svg aria-hidden="true" className="lanes" height={layout.height} width={layout.width}>
          <defs>
            <marker
              id="lane-arrow"
              markerHeight="7"
              markerWidth="7"
              orient="auto-start-reverse"
              refX="6"
              refY="3.5"
              viewBox="0 0 7 7"
            >
              <path className="arrow" d="M0 0.5 L6.5 3.5 L0 6.5 Z" />
            </marker>
          </defs>
          {layout.lanes.map((lane) => (
            <g
              className={`lane ${LANE_CLASS[lane.edge.state]} ${lane.edge.dashed ? "dashed" : ""}`}
              key={`${lane.edge.from}>${lane.edge.to}:${lane.edge.label ?? ""}`}
            >
              <path d={lanePath(lane.points)} markerEnd="url(#lane-arrow)" />
              {lane.label === null ? null : (
                <text textAnchor="middle" x={lane.label.x} y={lane.label.y + 4}>
                  {lane.edge.label}
                </text>
              )}
            </g>
          ))}
        </svg>
        {layout.stations.map(({ node, ...box }) => (
          <Station
            box={box}
            extra={extras.get(node.id)?.content ?? null}
            focused={props.focused === node.key && node.key !== null}
            key={node.id}
            node={node}
            onSelect={props.onSelect}
          />
        ))}
      </div>
    </TrackView>
  );
}

function Station(props: {
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly extra: ReactNode;
  readonly focused: boolean;
  readonly node: TrackNode;
  readonly onSelect: ((node: TrackNode) => void) | undefined;
}) {
  const { box, node } = props;
  const words = STATE_WORDS[node.state];
  const label =
    node.key === null ? (
      <span className="st-label">{node.label}</span>
    ) : (
      <StationFace label={node.label} meta={node.meta} state={node.state} />
    );
  return (
    <div
      aria-current={props.focused ? "step" : undefined}
      className={`station ${node.key === null ? `narration ${node.shape}` : "card"} ${node.state}`}
      data-state={node.state}
      data-step={node.key ?? undefined}
      data-testid="station"
      style={{
        left: box.x - box.width / 2,
        minHeight: box.height,
        top: box.y - box.height / 2,
        width: box.width,
      }}
    >
      {props.onSelect === undefined || node.key === null ? (
        <span className="st-hit">{label}</span>
      ) : (
        <button
          aria-label={words === "" ? node.label : `${node.label}, ${words}`}
          className="st-hit"
          onClick={() => props.onSelect?.(node)}
          type="button"
        >
          {label}
        </button>
      )}
      {props.extra === null ? null : <div className="st-act">{props.extra}</div>}
    </div>
  );
}
