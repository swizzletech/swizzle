// Draws a `TrackGraph`: dagre places the stations, an SVG underneath carries the lanes and their
// labels, and each station is an HTML element on top, so its text wraps, its state is a class and
// an approval station holds real buttons. Dagre loads on the first track drawn. A track wider than
// its card shrinks to fit, down to MIN_SCALE, and scrolls sideways beyond that.

import { type ReactNode, useEffect, useState } from "react";

import type { LaneState, StationState, TrackEdge, TrackGraph, TrackNode } from "../lib/track";
import { ErrorNote } from "./ui";
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
  /** Where dagre put the label, when the lane has one. */
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
  ])
    .then(([graphlib, layout]) => ({ Graph: graphlib.Graph, layout: layout.layout }))
    .catch((error: unknown) => {
      // A failed chunk load is not final: the next mount tries again.
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

/** Extra height a station needs for what sits under its label. */
export interface StationExtra {
  readonly height: number;
  readonly width: number;
}

/** The smallest a track shrinks to fit its card, so 12.5 px labels stay 10 px. */
const MIN_SCALE = 0.8;

/** The width inside an element, kept current as the window resizes; null until it mounts. */
function useInnerWidth(): readonly [(element: HTMLElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (element === null) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setWidth(
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

const BASE_WIDTH = 96;
const MAX_WIDTH = 200;
const BASE_HEIGHT = 46;

function stationSize(node: TrackNode, extra: StationExtra | null) {
  const text = Math.max(node.label.length, (node.key ?? "").length) * 6.6 + 30;
  const width = Math.max(Math.min(Math.round(text), MAX_WIDTH), BASE_WIDTH, extra?.width ?? 0);
  const lines = Math.ceil((node.label.length * 6.6) / (width - 28));
  const height =
    BASE_HEIGHT +
    Math.max(0, lines - 1) * 16 +
    (node.meta === null ? 0 : 16) +
    (node.durationMs === null ? 0 : 8) +
    (extra?.height ?? 0);
  return node.shape === "diamond" ? { height: height + 10, width: width + 24 } : { height, width };
}

function layoutTrack(
  lib: Dagre,
  track: TrackGraph,
  direction: TrackGraph["direction"],
  extras: ReadonlyMap<string, StationExtra>,
): Layout {
  const graph = new lib.Graph({ multigraph: true })
    .setGraph({
      edgesep: 18,
      marginx: 6,
      marginy: 6,
      nodesep: 20,
      rankdir: direction,
      ranksep: direction === "LR" ? 36 : 32,
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
        height: label === "" ? 0 : 18,
        labelpos: "c",
        width: label === "" ? 0 : label.length * 6.5 + 10,
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

/** A lane as one path through dagre's points, with its corners softened. */
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
  waiting: "waiting",
};

const LANE_CLASS: Record<LaneState, string> = {
  active: "active",
  done: "done",
  idle: "",
  untaken: "untaken",
};

export function Track(props: {
  readonly track: TrackGraph;
  /** Overrides the flow's direction; the phone draws every track top-down. */
  readonly direction?: TrackGraph["direction"];
  /** What a station holds under its label, such as the approval's buttons. */
  readonly extra?: (
    node: TrackNode,
  ) => { readonly content: ReactNode; readonly size: StationExtra } | null;
  /** The station the Play tab shows the code of. */
  readonly focused?: string | null;
  readonly onSelect?: (node: TrackNode) => void;
  readonly testId?: string;
}) {
  const { track } = props;
  const direction = props.direction ?? track.direction;
  const [lib, setLib] = useState<Dagre | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [measured, available] = useInnerWidth();
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
        title="The track could not be drawn."
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
  const longest = Math.max(0, ...track.nodes.map((node) => node.durationMs ?? 0));
  const scale =
    available === null || layout.width === 0
      ? 1
      : Math.min(1, Math.max(MIN_SCALE, available / layout.width));

  return (
    <div className="track-scroll" ref={measured}>
      <div
        className="track"
        data-direction={direction}
        data-testid={props.testId}
        style={{ height: layout.height, width: layout.width, zoom: scale }}
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
            longestMs={longest}
            node={node}
            onSelect={props.onSelect}
          />
        ))}
      </div>
    </div>
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
  readonly longestMs: number;
  readonly node: TrackNode;
  readonly onSelect: ((node: TrackNode) => void) | undefined;
}) {
  const { box, node } = props;
  const words = STATE_WORDS[node.state];
  const label = (
    <>
      <span className="st-label">{node.label}</span>
      {node.meta === null ? null : <span className="st-meta">{node.meta}</span>}
      {node.durationMs === null || props.longestMs === 0 ? null : (
        <span className="st-bar" title={node.meta ?? undefined}>
          <i style={{ width: `${Math.max(6, (node.durationMs / props.longestMs) * 100)}%` }} />
        </span>
      )}
    </>
  );
  return (
    <div
      aria-current={props.focused ? "step" : undefined}
      className={`station ${node.shape} ${node.state} ${node.key === null ? "narration" : ""}`}
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
