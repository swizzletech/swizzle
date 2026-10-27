// The live track above an automation's runs: its flow with the selected run's position on it, or,
// with no run selected, every station with how many recent runs reached it. It folds away, and the
// browser remembers the fold. A run waiting at an approval station is decided on that station.

import { useEffect, useState } from "react";
import type { RunDetail } from "../lib/api";
import { activeStep, staticTrack, type TrackNode, trackForRun } from "../lib/track";
import type { AutomationFlow } from "../lib/use-automation-flow";
import { useRunPosition } from "../lib/use-run-track";
import { approvalDetailsInWords, assigneeInWords, runStatusInWords } from "../lib/words/runs";
import { ApprovalActions } from "./actions";
import { Track } from "./track";
import { usePhone } from "./ui";
import "./flow-track.css";

const FOLD_KEY = "swizzle.dashboard.flow-track-folded";

/** Whether the owner folded the track in this browser; the choice outlives reloads. */
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
  /** The selected run; null draws the static track with reach counts. */
  readonly run: RunDetail | null;
  /** Whether the station of this step carries its approval; the run panel reads the same answer. */
  readonly approvalOnTrack: (stepKey: string) => boolean;
}) {
  const { flow, folded, run } = props;
  const { graph } = flow;
  if (graph === null) return null;
  return (
    <section className="card track-card" data-testid="flow-track">
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
        <Track testId="track" track={staticTrack(graph, flow.stepKeys, flow.reach)} />
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

/** Which run the track shows, or how many runs the reach counts come from. */
function trackHeadline(flow: AutomationFlow, run: RunDetail | null): string {
  if (run !== null) return `run ${run.runId.slice(0, 8)} · ${runStatusInWords(run)}`;
  if (flow.reach === null || flow.reach.runs === 0) return "no runs yet";
  return `last ${flow.reach.runs} ${flow.reach.runs === 1 ? "run" : "runs"}`;
}

/** Where the flow and the code disagree, in one line; the full list is the title. */
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
  const phone = usePhone();
  const track = trackForRun(props.graph, props.run, position, props.flow.stepKeys);
  return (
    <Track
      direction={phone ? "TB" : props.graph.direction}
      extra={(node) => (props.approvalOnTrack(node.id) ? approvalOnStation(node, props.run) : null)}
      focused={activeStep(track)}
      testId="track"
      track={track}
    />
  );
}

/**
 * The approval on the station the run waits at, instead of a card elsewhere: what the automation
 * asks, who decides, and Approve and Reject.
 */
export function approvalOnStation(node: TrackNode, run: RunDetail) {
  if (node.state !== "waiting" || run.approval === null || run.approval.stepKey !== node.key) {
    return null;
  }
  const asks = approvalDetailsInWords(run.approval.details);
  const assignee = assigneeInWords(run.approval.assignee);
  return {
    content: (
      <>
        {asks === null ? null : (
          <span className="st-ask" title={asks}>
            {asks}
          </span>
        )}
        {assignee === null ? null : <span className="st-ask">Assigned to {assignee}</span>}
        <ApprovalActions may={run.approval.may} runId={run.runId} stepKey={run.approval.stepKey} />
      </>
    ),
    // Room for the tallest the actions get: Reassign adds a row beside Approve and Reject, and its
    // form takes four rows where the comment and the buttons took two.
    size: {
      height:
        88 +
        (asks === null ? 0 : 34) +
        (assignee === null ? 0 : 18) +
        (run.approval.may.reassign ? 68 : 0),
      width: 220,
    },
  };
}
