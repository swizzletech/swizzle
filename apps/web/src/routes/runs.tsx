import { useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useState } from "react";

import { Page } from "../components/page";
import { RunPanel } from "../components/run-panel";
import { RunWorkbench, useRunSplit } from "../components/run-workbench";
import type { RunState } from "../lib/api";
import { useAutomations } from "../lib/queries";
import { RUN_FILTERS, type RunFilter } from "../lib/search";
import { useRunPages } from "../lib/use-run-pages";
import { runCountInWords } from "../lib/words/runs";

const FILTER: Record<
  RunFilter,
  {
    readonly label: string;
    readonly states: readonly RunState[];
    readonly approvalOnly?: boolean;
  }
> = {
  all: { label: "All", states: [] },
  failed: { label: "Failed", states: ["failed", "dead-lettered"] },
  "needs-you": { approvalOnly: true, label: "Needs you", states: [] },
  running: { label: "Running", states: ["queued", "running"] },
  succeeded: { label: "Succeeded", states: ["succeeded"] },
};

export function RunsPage() {
  const search = useSearch({ from: "/runs" });
  const navigate = useNavigate({ from: "/runs" });
  const filter: RunFilter = search.status ?? "all";
  const pages = useRunPages({
    approvalOnly: FILTER[filter].approvalOnly === true,
    states: FILTER[filter].states,
    ...(search.automation === undefined ? {} : { automation: search.automation }),
  });
  const view = useRunSplit(search.selected, pages.runs?.[0]?.runId);

  return (
    <Page
      actions={
        <>
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
        </>
      }
      note={
        pages.runs === undefined
          ? undefined
          : `${runCountInWords(pages.runs.length, pages.complete)} · live`
      }
      title="Runs"
      type="workbench"
    >
      <RunWorkbench
        empty="No run matches these filters"
        leads="automation"
        onBack={() => void navigate({ search: ({ selected: _selected, ...previous }) => previous })}
        onSelect={(runId, options) =>
          void navigate({
            replace: options?.replace ?? false,
            search: (previous) => ({ ...previous, selected: runId }),
          })
        }
        pages={pages}
        run={(runId) => (
          <RunPanel
            onSelectRun={(next) =>
              void navigate({ search: (previous) => ({ ...previous, selected: next }) })
            }
            runId={runId}
            showAutomationLink
          />
        )}
        view={view}
      />
    </Page>
  );
}

function AutomationFilter(props: {
  readonly value: string | undefined;
  readonly onChange: (slug: string | undefined) => void;
}) {
  const listId = useId();
  const automations = useAutomations().data ?? [];
  const current = automations.find((automation) => automation.automationSlug === props.value);
  const [text, setText] = useState<string | null>(null);
  const [shown, setShown] = useState(props.value);
  if (shown !== props.value) {
    setShown(props.value);
    setText(null);
  }
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label="Automation"
        className="field w-48"
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
