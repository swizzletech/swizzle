import {
  type ApprovalDetailsInWords,
  approvalDetailsInWords,
  stepFamily,
} from "@swizzle/config/browser";
import { useEffect, useState } from "react";
import type { RunDetail } from "../lib/api";
import { activeStep, staticTrack, type TrackNode, trackForRun } from "../lib/track";
import type { AutomationFlow } from "../lib/use-automation-flow";
import { useRunPosition } from "../lib/use-run-track";
import { assigneeInWords, runStatusInWords } from "../lib/words/runs";
import { ApprovalActions, ApprovalDetails } from "./actions";
import { Track } from "./track";
import "./flow-track.css";

const FOLD_KEY = "swizzle.dashboard.flow-track-folded";

export function useTrackFolded(): [boolean, (folded: boolean) => void] {
  const [folded, setFolded] = useState(() => window.localStorage.getItem(FOLD_KEY) === "true");
  useEffect(() => {
    window.localStorage.setItem(FOLD_KEY, String(folded));
  }, [folded]);
  return [folded, setFolded];
}

export function FlowTrack(props: {
  readonly flow: AutomationFlow;
  readonly folded: boolean;
  readonly onFold: (folded: boolean) => void;
  readonly run: RunDetail | null;
  readonly approvalOnTrack: (stepKey: string) => boolean;
}) {
  const { flow, folded, run } = props;
  const { graph } = flow;
  if (graph === null) return null;
  return (
    <section className="flow-band" data-testid="flow-track">
      <div className="track-head">
        <button
          aria-expanded={!folded}
          className="track-fold"
          onClick={() => props.onFold(!folded)}
          type="button"
        >
          <span aria-hidden="true" className="chev">
            {folded ? "▸" : "▾"}
          </span>
          Flow
        </button>
        <span className="t-meta">{trackHeadline(flow, run)}</span>
        <DriftNote flow={flow} />
      </div>
      {folded ? null : run === null ? (
        <Track testId="track" track={staticTrack(graph, flow.families, flow.reach)} />
      ) : (
        <RunTrack
          approvalOnTrack={props.approvalOnTrack}
          flow={flow}
          graph={graph}
          key={run.runId}
          run={run}
        />
      )}
    </section>
  );
}

function trackHeadline(flow: AutomationFlow, run: RunDetail | null): string {
  if (run !== null) return `run ${run.runId.slice(0, 8)} · ${runStatusInWords(run)}`;
  if (flow.reach === null || flow.reach.runs === 0) return "no runs yet";
  return `last ${flow.reach.runs} ${flow.reach.runs === 1 ? "run" : "runs"}`;
}

export function DriftNote({ flow }: { readonly flow: AutomationFlow }) {
  const steps = flow.drift.length;
  if (steps === 0) return null;
  return (
    <span
      className="t-faint ml-auto text-warn-text"
      data-testid="flow-drift"
      title={flow.drift.map((warning) => warning.message).join("\n")}
    >
      {steps} {steps === 1 ? "step" : "steps"} without a node
    </span>
  );
}

function RunTrack(props: {
  readonly approvalOnTrack: (stepKey: string) => boolean;
  readonly flow: AutomationFlow;
  readonly graph: NonNullable<AutomationFlow["graph"]>;
  readonly run: RunDetail;
}) {
  const { position } = useRunPosition(props.run);
  const track = trackForRun(props.graph, props.run, position, props.flow.families);
  return (
    <Track
      extra={(node) => (props.approvalOnTrack(node.id) ? approvalOnStation(node, props.run) : null)}
      focused={activeStep(track)}
      testId="track"
      track={track}
    />
  );
}

export function approvalOnStation(node: TrackNode, run: RunDetail) {
  if (
    node.state !== "waiting" ||
    run.approval === null ||
    stepFamily(run.approval.stepKey) !== node.key
  ) {
    return null;
  }
  const asks = approvalDetailsInWords(run.approval.details);
  const assignee = assigneeInWords(run.approval.assignee);
  return {
    content: (
      <>
        <div className="st-details">
          <ApprovalDetails details={run.approval.details} stacked />
        </div>
        {assignee === null ? null : <span className="st-ask">Assigned to {assignee}</span>}
        <ApprovalActions may={run.approval.may} runId={run.runId} stepKey={run.approval.stepKey} />
      </>
    ),
    size: {
      height:
        88 +
        detailsHeight(asks) +
        (assignee === null ? 0 : 24) +
        (run.approval.may.reassign ? 72 : 0),
      width: 220,
    },
  };
}

function detailsHeight(asks: ApprovalDetailsInWords): number {
  const lines = (text: string, charWidth: number) => {
    let width = 0;
    for (const char of text)
      width += (char.codePointAt(0) ?? 0) >= 0x1100 ? 2 * charWidth : charWidth;
    return Math.max(1, Math.ceil(width / 180));
  };
  const heading = asks.heading === null ? 0 : lines(asks.heading, 6.2) * 16 + 4;
  const fields = asks.fields.reduce(
    (sum, field) =>
      sum + (lines(field.label, 6.2) + lines(field.value, field.json ? 7.8 : 6.2)) * 16,
    0,
  );
  return heading + fields;
}
