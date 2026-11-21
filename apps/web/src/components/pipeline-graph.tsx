import { useNavigate } from "@tanstack/react-router";

import { type AutomationSummary, isOpenRun, type RunListItem } from "../lib/api";
import { invokeTargets } from "../lib/pipeline-grouping";
import type { StationState, TrackEdge, TrackGraph, TrackNode } from "../lib/track";
import { runStatusInWords } from "../lib/words/runs";
import { Track } from "./track";
import "./pipeline-graph.css";

const RUN_STATION: Record<RunListItem["state"], StationState> = {
  cancelled: "idle",
  "dead-lettered": "failed",
  failed: "failed",
  queued: "running",
  running: "running",
  succeeded: "done",
  waiting: "waiting",
};

function pipelineTrack(members: readonly AutomationSummary[]): TrackGraph {
  const bySlug = new Map(members.map((member) => [member.automationSlug, member]));
  const nodes: TrackNode[] = members.map((member) => ({
    at: member.lastRun === null ? null : Date.parse(member.lastRun.queuedAt),
    id: member.automationSlug,
    key: member.automationSlug,
    label: member.automationName,
    meta: member.lastRun === null ? "no runs yet" : runStatusInWords(member.lastRun),
    shape: "box",
    state: member.lastRun === null ? "idle" : RUN_STATION[member.lastRun.state],
  }));
  const edges: TrackEdge[] = [];
  for (const member of members) {
    for (const source of member.trigger?.chainSourceAutomationSlugs ?? []) {
      const from = bySlug.get(source);
      if (from === undefined) continue;
      const joined =
        member.lastRun?.chainSourceRunIds.some((runId) => runId === from.lastRun?.runId) ?? false;
      edges.push({
        dashed: false,
        from: source,
        label: null,
        state: laneState(from, member, joined),
        to: member.automationSlug,
      });
    }
    for (const target of invokeTargets(member)) {
      const to = bySlug.get(target);
      if (to === undefined) continue;
      const joined = to.lastRun?.parentRunId === member.lastRun?.runId;
      edges.push({
        dashed: true,
        from: member.automationSlug,
        label: null,
        state: laneState(member, to, joined && to.lastRun !== null),
        to: target,
      });
    }
  }
  return { edges, nodes };
}

function laneState(
  from: AutomationSummary,
  to: AutomationSummary,
  joined: boolean,
): TrackEdge["state"] {
  if (!joined || from.lastRun === null || to.lastRun === null) return "idle";
  return isOpenRun(to.lastRun.status) ? "active" : "done";
}

export function PipelineGraph(props: { readonly members: readonly AutomationSummary[] }) {
  const navigate = useNavigate();
  return (
    <div className="pgraph" data-testid="pipeline-graph">
      <Track
        onSelect={(node) => {
          if (node.key !== null) {
            void navigate({
              params: { automationSlug: node.key },
              to: "/automations/$automationSlug",
            });
          }
        }}
        track={pipelineTrack(props.members)}
      />
    </div>
  );
}
