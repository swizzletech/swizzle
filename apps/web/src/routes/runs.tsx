// Runs `/runs`: every run of the environment, filtered by what the owner asks ("what needs me",
// "what failed") and by automation, with the selected run beside the list. A phone shows one at a
// time: the list, or the run a tap or a link chose, with a way back to the list.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useState } from "react";

import { RunPanel, RunRow } from "../components/run-panel";
import { RunSplit, useRunSplit } from "../components/run-split";
import { ErrorNote, Skeleton } from "../components/ui";
import type { RunStatus } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { useAutomations } from "../lib/queries";
import { RUN_FILTERS, type RunFilter } from "../lib/search";

const FILTER: Record<
  RunFilter,
  {
    readonly label: string;
    readonly statuses: readonly RunStatus[];
    readonly approvalOnly?: boolean;
  }
> = {
  all: { label: "All", statuses: [] },
  failed: { label: "Failed", statuses: ["failed", "dead-lettered"] },
  "needs-you": { approvalOnly: true, label: "Needs you", statuses: [] },
  running: { label: "Running", statuses: ["queued", "running"] },
  succeeded: { label: "Succeeded", statuses: ["succeeded"] },
};

export function RunsPage() {
  const search = useSearch({ from: "/runs" });
  const { api, queryScope } = useDashboardClient();
  const navigate = useNavigate({ from: "/runs" });
  const filter: RunFilter = search.status ?? "all";
  const runsQuery = useQuery({
    queryFn: () =>
      api.listRuns({
        approvalOnly: FILTER[filter].approvalOnly === true,
        limit: 100,
        statuses: FILTER[filter].statuses,
        ...(search.automation === undefined ? {} : { automation: search.automation }),
      }),
    queryKey: ["runs", filter, search.automation ?? null, ...queryScope],
    refetchInterval: 5_000,
  });
  const runs = runsQuery.data?.runs ?? [];
  const view = useRunSplit(search.selected, runs[0]?.runId);
  const select = (runId: string) =>
    void navigate({ search: (previous) => ({ ...previous, selected: runId }) });

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="t-page">Runs</h1>
        {runsQuery.data ? (
          <span className="t-meta">
            {runs.length} {runs.length === 1 ? "run" : "runs"} · live
          </span>
        ) : null}
      </div>
      <div className="mt-4 mb-4 flex flex-wrap items-center gap-3">
        <div aria-label="Status" className="tabs" role="tablist">
          {RUN_FILTERS.map((key) => (
            <button
              aria-selected={filter === key}
              className="tab"
              key={key}
              onClick={() =>
                void navigate({
                  search: (previous) => ({
                    ...(previous.automation === undefined
                      ? {}
                      : { automation: previous.automation }),
                    ...(key === "all" ? {} : { status: key }),
                  }),
                })
              }
              role="tab"
              type="button"
            >
              {FILTER[key].label}
            </button>
          ))}
        </div>
        <AutomationFilter
          onChange={(automation) =>
            void navigate({
              search: (previous) => ({
                ...(previous.status === undefined ? {} : { status: previous.status }),
                ...(automation === undefined ? {} : { automation }),
              }),
            })
          }
          value={search.automation}
        />
      </div>

      {runsQuery.isError ? (
        <ErrorNote
          error={runsQuery.error}
          onRetry={() => void runsQuery.refetch()}
          title="The runs could not be loaded."
        />
      ) : runsQuery.data === undefined ? (
        <div className="card">
          <Skeleton label="Loading runs" lines={6} />
        </div>
      ) : (
        // A selected run stays open when it leaves the list, e.g. the last approval just granted.
        <RunSplit
          list={
            runs.length === 0 ? (
              <p className="card t-meta p-6">No run matches these filters.</p>
            ) : (
              <div className="card rows overflow-hidden" data-testid="run-list">
                {runs.map((run) => (
                  <RunRow
                    key={run.runId}
                    onSelect={select}
                    run={run}
                    selected={run.runId === view.selected}
                    showAutomation
                  />
                ))}
              </div>
            )
          }
          onBack={() =>
            void navigate({ search: ({ selected: _selected, ...previous }) => previous })
          }
          run={(runId) => <RunPanel onSelectRun={select} runId={runId} showAutomationLink />}
          view={view}
        />
      )}
    </>
  );
}

/** One field that searches the automations by name; a full name picks it. */
function AutomationFilter(props: {
  readonly value: string | undefined;
  readonly onChange: (slug: string | undefined) => void;
}) {
  const listId = useId();
  const automations = useAutomations().data ?? [];
  const current = automations.find((automation) => automation.automationSlug === props.value);
  const [text, setText] = useState<string | null>(null);
  // Back, Forward or Clear changes the filter from outside; the field then shows it again.
  const [shown, setShown] = useState(props.value);
  if (shown !== props.value) {
    setShown(props.value);
    setText(null);
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        aria-label="Automation"
        className="field w-60"
        list={listId}
        onChange={(event) => {
          const typed = event.target.value;
          setText(typed);
          const match = automations.find((automation) => automation.automationName === typed);
          if (match !== undefined) props.onChange(match.automationSlug);
          if (typed === "") props.onChange(undefined);
        }}
        placeholder="All automations"
        value={text ?? current?.automationName ?? props.value ?? ""}
      />
      <datalist id={listId}>
        {automations.map((automation) => (
          <option key={automation.automationSlug} value={automation.automationName} />
        ))}
      </datalist>
      {props.value === undefined ? null : (
        <button className="btn quiet small" onClick={() => props.onChange(undefined)} type="button">
          Clear
        </button>
      )}
    </div>
  );
}
