import type { FlowGraph, FlowNode } from "./track";

interface FlowVertexLike {
  readonly id: string;
  readonly text?: string;
  readonly type?: string;
}

interface FlowEdgeLike {
  readonly start: string;
  readonly end: string;
  readonly text?: string;
}

interface FlowDbLike {
  getDirection(): string | undefined;
  getVertices(): Map<string, FlowVertexLike>;
  getEdges(): readonly FlowEdgeLike[];
}

let mermaidModule: Promise<typeof import("mermaid").default> | null = null;

function mermaid() {
  mermaidModule ??= import("mermaid").then(({ default: instance }) => {
    instance.initialize({ securityLevel: "strict", startOnLoad: false });
    return instance;
  });
  return mermaidModule;
}

const PILL_SHAPES = new Set(["round", "stadium", "circle", "doublecircle", "ellipse"]);
const DIAMOND_SHAPES = new Set(["diamond", "hexagon"]);

function shapeOf(type: string | undefined): FlowNode["shape"] {
  if (type !== undefined && DIAMOND_SHAPES.has(type)) return "diamond";
  if (type !== undefined && PILL_SHAPES.has(type)) return "pill";
  return "box";
}

export async function parseFlow(code: string): Promise<FlowGraph | null> {
  const instance = await mermaid();
  const diagram = await instance.mermaidAPI.getDiagramFromText(code).catch(() => null);
  if (diagram === null || !diagram.type.startsWith("flowchart")) return null;
  const db = diagram.db as unknown as FlowDbLike;
  const nodes = [...db.getVertices().values()].map((vertex) => ({
    id: vertex.id,
    label: vertex.text === undefined || vertex.text === "" ? vertex.id : vertex.text,
    shape: shapeOf(vertex.type),
  }));
  const edges = db.getEdges().map((edge) => ({
    from: edge.start,
    label: edge.text === undefined || edge.text === "" ? null : edge.text,
    to: edge.end,
  }));
  return { edges, nodes };
}
