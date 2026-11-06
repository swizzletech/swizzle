// One run, as the Runs page and the automation's Runs tab show it in the run pane of their
// workbench: the status in words, the facts with the worker each execution ran on, the cause in
// words for a failed run, why a queued run waits for a worker, the approval card for an approval
// wait, the actions, and the run's error, output, logs, payload and steps.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { type ExplainedPlacement, isOpenRun, type RunDetail } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { refreshAll } from "../lib/queries";
import { useRunLogStream } from "../lib/use-run-log-stream";
import { refusedControlsInWords } from "../lib/words/access";
import { RUN_TONE } from "../lib/words/health";
import { failedRunHandoff } from "../lib/words/overview";
import {
  approvalDecisionInWords,
  assigneeInWords,
  ranOnInWords,
  runDetailStatusInWords,
  runDurationInWords,
  runStatusInWords,
  versionInWords,
} from "../lib/words/runs";
import { ageInWords, deadlineInWords } from "../lib/words/time";
import { workerStateInWords } from "../lib/words/workers";
import { ActionError, ApprovalActions, ApprovalDetails } from "./actions";
import { CopyButton, Dot, ErrorNote, Skeleton, useNow, WithCode } from "./ui";
import "./run-panel.css";

type InnerTab = "error" | "output" | "logs" | "payload" | "steps";

const TAB_LABEL: Record<InnerTab, string> = {
  error: "Error",
  logs: "Logs",
  output: "Output",
  payload: "Payload",
  steps: "Steps",
};

export function RunPanel(props: {
  readonly runId: string;
  /** Selects another run in the surrounding list, such as the one Run again starts. */
  readonly onSelectRun: (runId: string) => void;
  /** False inside the automation page, which is where Open automation leads. */
  readonly showAutomationLink: boolean;
  /** True when a track above the panel carries Approve and Reject on the station of that step. */
  readonly approvalOnTrack?: (stepKey: string) => boolean;
}) {
  const { api, queryScope } = useDashboardClient();
  const runQuery = useQuery({
    queryFn: () => api.getRunDetail(props.runId),
    queryKey: ["run", props.runId, ...queryScope],
    refetchInterval: (query) =>
      query.state.data !== undefined && isOpenRun(query.state.data.status) ? 3_000 : false,
  });

  if (runQuery.isError) {
    return (
      <div className="rp-body">
        <ErrorNote
          error={runQuery.error}
          onRetry={() => void runQuery.refetch()}
          title="This run could not be loaded."
        />
      </div>
    );
  }
  if (runQuery.data === undefined) return <Skeleton label="Loading the run" lines={6} />;
  // Keyed by run, so the inner tab starts over for each run.
  return <LoadedRun {...props} key={runQuery.data.runId} run={runQuery.data} />;
}

function LoadedRun(props: {
  readonly run: RunDetail;
  readonly onSelectRun: (runId: string) => void;
  readonly showAutomationLink: boolean;
  readonly approvalOnTrack?: (stepKey: string) => boolean;
}) {
  const { run } = props;
  const { api, queryScope } = useDashboardClient();
  const queryClient = useQueryClient();
  const now = useNow();
  const approval = run.approval;
  const cancelled = run.deadLetterReason === "user-cancelled";
  const failed = (run.status === "failed" || run.status === "dead-lettered") && !cancelled;
  const open = isOpenRun(run.status);
  const { cancel: cancelRefusal, edit: editRefusal, runAgain: runAgainRefusal } = run.refusals;
  // The agent a failed run is handed to changes and deploys the automation, which needs editor.
  const handsOff = failed && editRefusal === null;
  const refused = [
    ...(failed && editRefusal !== null ? [{ label: "Hand to agent", refusal: editRefusal }] : []),
    ...(open && cancelRefusal !== null ? [{ label: "Cancel run", refusal: cancelRefusal }] : []),
    ...(!open && runAgainRefusal !== null
      ? [{ label: "Run again", refusal: runAgainRefusal }]
      : []),
  ];
  const ranOn = ranOnInWords(run.executions);

  // A failed run's diagnosis never changes. A queued run's placement carries its own words, which
  // the run detail polls.
  const diagnosisQuery = useQuery({
    enabled: failed,
    queryFn: () => api.getRunDiagnosis(run.runId),
    queryKey: ["diagnosis", run.runId, ...queryScope],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const childrenQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: () => api.listRuns({ limit: 50, parentRunId: run.runId }),
    // `open` in the key reads the children once more when the run ends; a child may have finished
    // after the last poll.
    queryKey: ["child-runs", run.runId, open, ...queryScope],
    refetchInterval: (query) =>
      open || query.state.data?.runs.some((child) => isOpenRun(child.status)) ? 5_000 : false,
  });
  const runAgain = useMutation({
    mutationFn: () => api.replayRun(run.runId),
    onSuccess: async (started) => {
      props.onSelectRun(started.runId);
      await refreshAll(queryClient);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(run.runId),
    onSuccess: () => refreshAll(queryClient),
  });

  const tabs: readonly InnerTab[] = failed
    ? ["error", "output", "logs", "payload", "steps"]
    : ["output", "logs", "error", "payload", "steps"];
  const [chosenTab, setTab] = useState<InnerTab | null>(null);
  const tab = chosenTab ?? tabs[0] ?? "output";

  const children = childrenQuery.data?.runs ?? [];

  return (
    <div className="runpanel" data-testid="run-panel">
      <div className="rp-head">
        <div className="min-w-0">
          <div className="t-faint">
            Run {run.runId.slice(0, 8)}
            {props.showAutomationLink ? <> · {run.automationName}</> : null}
          </div>
          <h2 className="rp-title">
            <Dot tone={RUN_TONE[run.status]} />
            {runDetailStatusInWords(run)}
          </h2>
          {run.parentRunId === null ? null : (
            <p className="t-meta mt-1">
              Started by run{" "}
              <Link className="linkish mono" search={{ selected: run.parentRunId }} to="/runs">
                {run.parentRunId.slice(0, 8)}
              </Link>
              {run.parentStepKey === null ? null : <> at step {run.parentStepKey}</>}
            </p>
          )}
        </div>
        <div className="rp-acts">
          {cancelRefusal === null ? (
            <ReservedSlot active={open}>
              <button
                className="btn danger small"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
                type="button"
              >
                {cancel.isPending ? "Cancelling…" : "Cancel run"}
              </button>
            </ReservedSlot>
          ) : null}
          {runAgainRefusal === null ? (
            <ReservedSlot active={!open}>
              <button
                className="btn quiet small"
                disabled={runAgain.isPending || run.triggerType === "chain"}
                onClick={() => runAgain.mutate()}
                title={
                  run.triggerType === "chain"
                    ? "A chained run starts when its source finishes."
                    : "Starts a new run with the same payload."
                }
                type="button"
              >
                {runAgain.isPending ? "Starting…" : "Run again"}
              </button>
            </ReservedSlot>
          ) : null}
          {props.showAutomationLink ? (
            <Link
              className="btn quiet small"
              params={{ automationSlug: run.automationSlug }}
              to="/automations/$automationSlug"
            >
              Open automation
            </Link>
          ) : null}
        </div>
      </div>

      <div className="facts">
        <div>
          <span className="t-label">Started</span>
          <b>{run.startedAt === null ? "Not yet" : ageInWords(run.startedAt, now)}</b>
        </div>
        <div>
          <span className="t-label">Duration</span>
          <b>{runDurationInWords(run)}</b>
        </div>
        <div>
          <span className="t-label">Attempts</span>
          <b>
            {run.attemptsMade} of {run.attemptsMax}
          </b>
        </div>
        <div>
          <span className="t-label">Trigger</span>
          <b>{run.triggerType}</b>
        </div>
        <div>
          <span className="t-label">Version</span>
          <b>{versionInWords(run.version)}</b>
        </div>
        {run.executions.length < 2 ? null : (
          <div data-testid="run-executions">
            <span className="t-label">Executions</span>
            <b>{run.executions.length}</b>
          </div>
        )}
        {ranOn === null ? null : (
          <div data-testid="run-worker">
            <span className="t-label">Ran on</span>
            <b>{ranOn}</b>
          </div>
        )}
      </div>

      <div className="rp-body">
        {failed ? (
          <div className="errbox" data-testid="run-error">
            <b>{run.errorMessage ?? "The run failed without an error message."}</b>
            {diagnosisQuery.data ? (
              <>
                {/* An uncatalogued cause repeats the error; the title already says it. */}
                {diagnosisQuery.data.likelyCause.summary === run.errorMessage ? null : (
                  <p>{diagnosisQuery.data.likelyCause.summary}</p>
                )}
                {diagnosisQuery.data.suggestedFixes.map((fix) => (
                  <p key={fix.rationale}>
                    <WithCode text={fix.rationale} />
                    {fix.command === undefined ? null : (
                      <>
                        {" "}
                        <span className="mono">{fix.command}</span>
                      </>
                    )}
                  </p>
                ))}
              </>
            ) : null}
            {handsOff ? (
              <CopyButton
                className="btn mt-3"
                label="Hand to agent"
                text={failedRunHandoff({
                  attemptsMade: run.attemptsMade,
                  automationName: run.automationName,
                  diagnosisSummary: diagnosisQuery.data?.likelyCause.summary,
                  errorMessage: run.errorMessage,
                  runId: run.runId,
                  triggerType: run.triggerType,
                })}
              />
            ) : null}
          </div>
        ) : null}

        {run.placement === null ? null : <Placement now={now} placement={run.placement} />}

        {approval === null || props.approvalOnTrack?.(approval.stepKey) === true ? null : (
          <div className="notice grid gap-2" data-testid="approval-card">
            <div>
              <b>{run.automationName}</b> asks: <b>{approval.stepKey}</b>
              <ApprovalDetails details={approval.details} />
              {approval.assignee === null ? null : (
                <div className="t-meta">Assigned to {assigneeInWords(approval.assignee)}</div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ApprovalActions may={approval.may} runId={run.runId} stepKey={approval.stepKey} />
            </div>
          </div>
        )}

        <Decisions now={now} open={open} runId={run.runId} />

        {handsOff || refused.length > 0 || runAgain.isError || cancel.isError ? (
          <div className="ractions">
            {handsOff ? (
              <span className="t-faint">
                Hand to agent copies the run, the error and the commands to investigate.
              </span>
            ) : null}
            {refused.length === 0 ? null : (
              <span className="t-faint" data-testid="refused-controls">
                {refusedControlsInWords(refused)}
              </span>
            )}
            {runAgain.isError ? <ActionError error={runAgain.error} /> : null}
            {cancel.isError ? <ActionError error={cancel.error} /> : null}
          </div>
        ) : null}

        {children.length > 0 ? (
          <div>
            <p className="t-label mb-1">Child runs</p>
            <div className="card rows overflow-hidden">
              {children.map((child) => (
                <button
                  className="rp-child"
                  key={child.runId}
                  onClick={() => props.onSelectRun(child.runId)}
                  type="button"
                >
                  <Dot tone={RUN_TONE[child.status]} />
                  <span className="truncate">
                    <b>{child.automationName}</b>{" "}
                    <span className="t-faint">{runStatusInWords(child)}</span>
                  </span>
                  <span className="t-faint">{ageInWords(child.queuedAt, now)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div aria-label="Run detail" className="dtabs rp-tabs" role="tablist">
        {tabs.map((key) => (
          <button
            aria-selected={tab === key}
            className="dtab"
            key={key}
            onClick={() => setTab(key)}
            role="tab"
            type="button"
          >
            {TAB_LABEL[key]}
          </button>
        ))}
      </div>
      <div className="rp-view" role="tabpanel">
        <InnerTabBody run={run} tab={tab} />
      </div>
    </div>
  );
}

/**
 * A header action that exists in only some run states. Most runs in view have ended, so Run again
 * stands outermost and Cancel run's empty slot sits to its left. The other states keep its space, empty, so
 * the actions beside it stay put when the run changes state and a click aimed at one of them never
 * lands on another.
 */
function ReservedSlot(props: { readonly active: boolean; readonly children: ReactNode }) {
  return (
    <span
      aria-hidden={!props.active}
      className={props.active ? undefined : "invisible"}
      inert={!props.active}
    >
      {props.children}
    </span>
  );
}

/**
 * Why a queued run has not started, in the words `swizzle diagnose` prints: the reason and the
 * next steps, with the machines that could take it and when it fails.
 */
function Placement(props: { readonly now: Date; readonly placement: ExplainedPlacement }) {
  const { now, placement } = props;
  return (
    <div className="notice grid min-w-0 gap-1 wrap-anywhere" data-testid="run-placement">
      <b>{placement.words.summary}</b>
      {placement.workers.map((worker) => (
        <span key={worker.name}>
          {worker.name}: {workerStateInWords(worker, now)}
        </span>
      ))}
      <span className="t-meta">Fails at {deadlineInWords(placement.deadline, now)}</span>
      {placement.words.fixes.map((fix) => (
        <span className="t-meta" key={fix.rationale}>
          {fix.rationale}
          {fix.command === undefined ? null : (
            <>
              {" "}
              <span className="mono">{fix.command}</span>
            </>
          )}
        </span>
      ))}
    </div>
  );
}

function InnerTabBody(props: { readonly run: RunDetail; readonly tab: InnerTab }) {
  const { run } = props;
  switch (props.tab) {
    case "error":
      return <Screen empty="Nothing was written to stderr.">{run.stderr}</Screen>;
    case "output":
      if (run.status === "waiting") {
        return <Screen empty="">{`${runStatusInWords(run)}.`}</Screen>;
      }
      return (
        <Screen empty={isOpenRun(run.status) ? "No output yet." : "The run wrote no output."}>
          {run.result === null || run.result === undefined ? run.stdout : pretty(run.result)}
        </Screen>
      );
    case "logs":
      return <LiveLogs runId={run.runId} />;
    case "payload":
      return <Screen empty="The run started without a payload.">{pretty(run.payload)}</Screen>;
    case "steps":
      return <Steps open={isOpenRun(run.status)} runId={run.runId} />;
  }
}

function Screen(props: { readonly children: string; readonly empty: string }) {
  const text = props.children.trim();
  return (
    <pre className="screen max-h-[420px]">
      {text === "" ? <span className="c">{props.empty}</span> : text}
    </pre>
  );
}

/** Each execution's stderr, then live chunks while the run is still going. */
function LiveLogs(props: { readonly runId: string }) {
  const { chunks, error, streaming } = useRunLogStream(props.runId, true);
  const text = useMemo(() => chunks.map((chunk) => chunk.chunk).join(""), [chunks]);
  const screenRef = useRef<HTMLPreElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text length drives the scroll
  useEffect(() => {
    if (screenRef.current) screenRef.current.scrollTop = screenRef.current.scrollHeight;
  }, [text.length]);
  return (
    <div className="grid gap-2">
      {error === null ? null : <p className="t-meta text-fail">{error}</p>}
      <pre className="screen max-h-[420px]" ref={screenRef}>
        {text === "" ? (
          <span className="c">{streaming ? "Waiting for logs…" : "No logs."}</span>
        ) : (
          text
        )}
      </pre>
      {streaming ? (
        <span className="t-faint inline-flex items-center gap-2">
          <Dot tone="run" /> Live
        </span>
      ) : null}
    </div>
  );
}

function useRunSteps(runId: string, open: boolean) {
  const { api, queryScope } = useDashboardClient();
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () => api.listRunSteps(runId),
    // As with child runs, `open` in the key reads the steps once more when the run ends.
    queryKey: ["run-steps", runId, open, ...queryScope],
    refetchInterval: open ? 5_000 : false,
  });
}

/** Each approval step the run passed: the verdict, who gave it, for whom it was and the comment. */
function Decisions(props: { readonly now: Date; readonly open: boolean; readonly runId: string }) {
  const decided = (useRunSteps(props.runId, props.open).data ?? []).flatMap((step) =>
    step.approval === null ? [] : [{ decision: step.approval, stepKey: step.stepKey }],
  );
  if (decided.length === 0) return null;
  return (
    <div className="grid gap-2">
      {decided.map(({ decision, stepKey }) => (
        <div className="notice grid gap-1" data-testid="approval-decision" key={stepKey}>
          <div>
            <b>{stepKey}</b>: {approvalDecisionInWords(decision)} ·{" "}
            {ageInWords(decision.decidedAt, props.now)}
          </div>
          {decision.assignee === null ? null : (
            <div className="t-meta">Assigned to {assigneeInWords(decision.assignee)}</div>
          )}
          {decision.comment === null ? null : <div className="t-meta">“{decision.comment}”</div>}
        </div>
      ))}
    </div>
  );
}

function Steps(props: { readonly open: boolean; readonly runId: string }) {
  const stepsQuery = useRunSteps(props.runId, props.open);
  if (stepsQuery.isError)
    return <ErrorNote error={stepsQuery.error} title="Steps could not be loaded." />;
  if (stepsQuery.data === undefined) return <Skeleton label="Loading steps" lines={3} />;
  if (stepsQuery.data.length === 0) {
    return <Screen empty="This run recorded no durable steps.">{""}</Screen>;
  }
  return (
    <pre className="screen max-h-[420px]">
      {stepsQuery.data.map((step) => (
        <span key={`${step.stepKey}:${step.executionNumber}`}>
          <span className="p">{step.stepKey}</span>
          <span className="c"> · attempt {step.attempt}</span>
          {`\n${pretty(step.value)}\n\n`}
        </span>
      ))}
    </pre>
  );
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
