// Draws a `TrackGraph`: dagre places the stations, an SVG underneath carries the lanes and their
// labels, and each station is an HTML element on top, so its text wraps, its state is a class and
// an approval station holds real buttons. A step is a card with a state symbol, its label and a
// meta line (`StationFace`); a node that only narrates, such as the trigger, a decision or the end,
// is a quiet text marker. Dagre loads on the first track drawn. A track wider than its card shrinks
// to fit, down to MIN_SCALE, and scrolls sideways beyond that.

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

/** A card: 12.5 px label characters, the symbol, gap and padding beside the text, and slack. */
const CARD_CHAR = 6.6;
const CARD_CHROME = 52;
const CARD_SLACK = 8;
const CARD_MIN = 150;
const CARD_MAX = 220;
/** A narration marker: 12 px characters, its padding, a decision's diamond, and slack. */
const MARK_CHAR = 6.8;
const MARK_CHROME = 22;
const MARK_SLACK = 8;
const MARK_DIAMOND = 15;
const MARK_MAX = 200;

/**
 * The box dagre reserves. A card's size follows its label alone and always keeps room for its
 * meta line, so the layout holds still while a live run changes the meta from step to item to
 * duration.
 */
function stationSize(node: TrackNode, extra: StationExtra | null) {
  if (node.key === null) {
    const chrome = MARK_CHROME + (node.shape === "diamond" ? MARK_DIAMOND : 0);
    const width = Math.min(
      Math.round(node.label.length * MARK_CHAR + chrome + MARK_SLACK),
      MARK_MAX,
    );
    const lines = Math.ceil((node.label.length * MARK_CHAR) / (width - chrome));
    return { height: 24 + Math.max(0, lines - 1) * 15, width };
  }
  const text = node.label.length * CARD_CHAR + CARD_CHROME + CARD_SLACK;
  const width = Math.max(Math.min(Math.round(text), CARD_MAX), CARD_MIN, extra?.width ?? 0);
  const lines = Math.ceil((node.label.length * CARD_CHAR) / (width - CARD_CHROME));
  return { height: 18 + lines * 16 + 15 + (extra?.height ?? 0), width };
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
  untaken: "not taken",
  waiting: "waiting",
};

/** What a card draws on its state ring; idle and untaken draw the ring alone. */
const STATE_SYMBOL: Record<StationState, ReactNode> = {
  done: <path className="st-mark" d="M5 9.2 7.8 12 13 6.6" />,
  failed: <path className="st-mark" d="M6.2 6.2 11.8 11.8 M11.8 6.2 6.2 11.8" />,
  idle: null,
  running: <path className="st-mark" d="M9 1a8 8 0 0 1 8 8" />,
  untaken: null,
  waiting: <path className="st-mark" d="M9 5.6V9l2.4 1.6" />,
};

/**
 * A step's face: the state symbol, the label and the meta line, which ellipsizes and keeps the
 * whole text in its title. The track's cards and the Play's phone cards both draw it.
 */
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
