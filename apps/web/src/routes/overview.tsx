// The Overview `/`: the status sentence, Needs you, the automations as a timetable of their last 24
// hours and what changed recently, in that fixed order. An instance without automations shows only the three steps to the first one,
// or why the person may not deploy it.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ActionError } from "../components/actions";
import { useConfirm } from "../components/confirm";
import { HourAxis, HourStrip } from "../components/hour-strip";
import { Menu } from "../components/menu";
import { NeedsYou } from "../components/needs-you";
import { Page } from "../components/page";
import { PipelineGraph } from "../components/pipeline-graph";
import {
  Chip,
  CopyButton,
  Dot,
  ErrorNote,
  errorText,
  SectionHead,
  Skeleton,
  useNow,
  WithCode,
} from "../components/ui";
import type { AutomationFolder, AutomationSummary, Overview, Timetable } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { type AutomationListItem, groupAutomationsIntoPipelines } from "../lib/pipeline-grouping";
import { refreshAll, useAutomations, useFolders, useOverview } from "../lib/queries";
import { failingFirst, type TimetableLine } from "../lib/timetable";
import { refusedControlsInWords } from "../lib/words/access";
import { readinessLabel, type Tone } from "../lib/words/health";
import { changeInWords, statusSentence } from "../lib/words/overview";
import { ageInWords } from "../lib/words/time";
import { nextRunInWords, nextRunTimes, triggerInWords } from "../lib/words/triggers";
import "./overview.css";

export function OverviewPage() {
  const { environment } = useDashboardClient();
  const overview = useOverview();
  const automations = useAutomations();

  if (automations.data?.length === 0) return <EmptyInstance />;

  return (
    <Page description={`${environment} · last 24 hours`} title="Overview" type="overview">
      {overview.isError ? (
        <ErrorNote
          error={overview.error}
          onRetry={() => void overview.refetch()}
          title="The status could not be loaded"
        />
      ) : overview.data === undefined ? (
        <div className="card">
          <Skeleton label="Loading the status" lines={3} />
        </div>
      ) : (
        <StatusCard overview={overview.data} />
      )}

      {overview.data !== undefined && overview.data.needsYou.length > 0 ? (
        <>
          <SectionHead title="Needs you" />
          <NeedsYou items={overview.data.needsYou} />
        </>
      ) : null}

      {automations.isError ? (
        <>
          <SectionHead title="Automations" />
          <ErrorNote
            error={automations.error}
            onRetry={() => void automations.refetch()}
            title="The automations could not be loaded"
          />
        </>
      ) : automations.data === undefined || (overview.data === undefined && !overview.isError) ? (
        <>
          <SectionHead title="Automations" />
          <div className="card">
            <Skeleton label="Loading the automations" lines={4} />
          </div>
        </>
      ) : (
        <Automations automations={automations.data} timetable={overview.data?.timetable ?? null} />
      )}

      {/* After the list above it, so a list arriving later cannot push it down the page. */}
      {automations.data !== undefined &&
      overview.data !== undefined &&
      overview.data.recentChanges.length > 0 ? (
        <RecentlyChanged changes={overview.data.recentChanges} />
      ) : null}
    </Page>
  );
}

function StatusCard({ overview }: { readonly overview: Overview }) {
  const now = useNow();
  const { failures, title } = statusSentence(overview, now);
  const counts = overview.last24h;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const stats: readonly { readonly label: string; readonly count: number; readonly tone?: Tone }[] =
    [
      { count: total, label: total === 1 ? "Run" : "Runs" },
      { count: counts.succeeded, label: "Succeeded", tone: "ok" },
      { count: counts.failed + counts["dead-lettered"], label: "Failed", tone: "fail" },
      { count: counts.waiting, label: "Waiting", tone: "warn" },
    ];
  return (
    <div className="grid gap-4" data-testid="status-card">
      <div className="card state">
        <p>
          <b>{title}</b>
          {failures === null ? null : ` ${failures}`}
        </p>
        {failures === null ? null : (
          <Link className="btn quiet small" search={{ status: "failed" }} to="/runs">
            Show failed runs
          </Link>
        )}
      </div>
      <div className="card stats">
        {stats.map((stat) => (
          <div key={stat.label}>
            <span className="t-faint">
              {stat.tone === undefined ? null : <Dot tone={stat.tone} />}
              {stat.label}
            </span>
            <b className="t-stat">{stat.count}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The automations as a timetable: each one's last 24 hours hour by hour, those with a failure in
 * them first, and its next run. Without the Overview's timetable the rows keep an empty lane.
 */
function Automations(props: {
  readonly automations: readonly AutomationSummary[];
  readonly timetable: Timetable | null;
}) {
  const { automations, timetable } = props;
  const [folderId, setFolderId] = useState<string | null>(null);
  const shown =
    folderId === null
      ? automations
      : automations.filter((automation) => automation.folderId === folderId);
  const items = groupAutomationsIntoPipelines(shown);
  const lines =
    timetable === null
      ? items.map((item) => ({ item, line: null }))
      : failingFirst(items, timetable);
  return (
    <>
      <SectionHead title="Automations">
        <FolderTabs automations={automations} folderId={folderId} onSelect={setFolderId} />
      </SectionHead>
      <RefusedFolders folderId={folderId} />
      <div className="card rows timetable" data-testid="automations">
        <div className="arow head t-label">
          <span className="who">Automation</span>
          {timetable === null ? null : <HourAxis timetable={timetable} />}
          <span className="next">Next</span>
        </div>
        {lines.map(({ item, line }) => (
          <AutomationRow item={item} key={rowKey(item)} line={line} timetable={timetable} />
        ))}
        {shown.length === 0 ? (
          <p className="t-meta px-4 py-3">
            No automation is in this folder. Move one here from its ⋯ menu.
          </p>
        ) : null}
      </div>
    </>
  );
}

function rowKey(item: AutomationListItem): string {
  return item.kind === "group" ? item.key : item.automation.automationSlug;
}

function AutomationRow(props: {
  readonly item: AutomationListItem;
  readonly line: TimetableLine | null;
  readonly timetable: Timetable | null;
}) {
  const { item } = props;
  const [graphOpen, setGraphOpen] = useState(false);
  const automation = item.kind === "group" ? item.entry : item.automation;
  const trigger = triggerInWords(automation.trigger);
  // The name link stretches over the whole row; the strip and a pipeline's member links sit above
  // it, so each opens on its own without nesting links.
  return (
    <>
      <div className="arow linked" data-testid="automation-row">
        <div className="who min-w-0">
          <div className="name">
            <Link
              className="stretch"
              params={{ automationSlug: automation.automationSlug }}
              to="/automations/$automationSlug"
            >
              {automation.automationName}
            </Link>
            {item.kind === "group" ? (
              <span className="t-faint font-medium"> · pipeline</span>
            ) : null}
          </div>
          <div className="trigger" title={trigger.replaceAll("`", "")}>
            <WithCode text={trigger} />
          </div>
          {item.kind === "group" ? (
            <div className="steps">
              {item.layers.map((layer, index) => (
                <span
                  className="contents"
                  key={layer.map((member) => member.automationSlug).join()}
                >
                  {index > 0 ? "→" : null}
                  {layer.map((member) => (
                    <Link
                      className="member"
                      key={member.automationSlug}
                      params={{ automationSlug: member.automationSlug }}
                      to="/automations/$automationSlug"
                    >
                      {member.automationName}
                    </Link>
                  ))}
                </span>
              ))}
              <button
                aria-expanded={graphOpen}
                className="member graph-toggle"
                data-testid="pipeline-graph-toggle"
                onClick={() => setGraphOpen(!graphOpen)}
                type="button"
              >
                {graphOpen ? "Hide graph" : "Graph"}
              </button>
            </div>
          ) : null}
        </div>
        {props.line === null || props.timetable === null ? null : (
          <HourStrip
            automationSlug={automation.automationSlug}
            line={props.line}
            timetable={props.timetable}
          />
        )}
        <NextCell automation={automation} />
      </div>
      {graphOpen && item.kind === "group" ? <PipelineGraph members={item.members} /> : null}
    </>
  );
}

/** The next run as a clock time over how far off it is, or what keeps the automation from it. */
function NextCell(props: { readonly automation: AutomationSummary }) {
  const now = useNow();
  const { trigger } = props.automation;
  const readiness = props.automation.activeDeployment.readiness;
  if (trigger?.status === "invalid") {
    return (
      <span className="next">
        <Chip tone="fail">Broken</Chip>
      </span>
    );
  }
  if (readiness.status === "not-ready") {
    return (
      <span className="next" title={readiness.errors.map((issue) => issue.message).join("\n")}>
        <Chip tone="warn">{readinessLabel(readiness)}</Chip>
      </span>
    );
  }
  if (trigger?.status === "paused") {
    return (
      <span className="next">
        <Chip tone="idle">Paused</Chip>
      </span>
    );
  }
  const times = nextRunTimes(trigger, now);
  return times === null ? (
    <span className="next t-meta">{nextRunInWords(trigger, now)}</span>
  ) : (
    <span className="next t-meta">
      {times.at}
      <span className="relative">{times.relative}</span>
    </span>
  );
}

/** Why New folder, or Rename and Delete of the shown folder, are not offered. */
function RefusedFolders(props: { readonly folderId: string | null }) {
  const listed = useFolders().data;
  const folder = listed?.folders.find((candidate) => candidate.id === props.folderId);
  const refused = [
    ...(listed?.create ? [{ label: "New folder", refusal: listed.create }] : []),
    ...(folder?.refusal
      ? [{ label: `Rename and Delete of ${folder.name}`, refusal: folder.refusal }]
      : []),
  ];
  return refused.length === 0 ? null : (
    <p className="t-meta m-0" data-testid="refused-controls">
      {refusedControlsInWords(refused)}
    </p>
  );
}

function FolderTabs(props: {
  readonly automations: readonly AutomationSummary[];
  readonly folderId: string | null;
  readonly onSelect: (folderId: string | null) => void;
}) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const listed = useFolders();
  const folders = listed.data?.folders ?? [];
  // A refusal that arrives with a refetch also closes an open New folder form.
  const mayCreate = listed.data?.create === null;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createAutomationFolder(name.trim()),
    onSuccess: async (folder) => {
      setAdding(false);
      setName("");
      props.onSelect(folder.id);
      await refreshAll(queryClient);
    },
  });
  const selected = folders.find((folder) => folder.id === props.folderId);
  const count = (folderId: string) =>
    props.automations.filter((automation) => automation.folderId === folderId).length;

  return (
    <div aria-label="Folders" className="tabs" role="tablist">
      <button
        aria-selected={props.folderId === null}
        className="tab"
        onClick={() => props.onSelect(null)}
        role="tab"
        type="button"
      >
        All <span className="n">{props.automations.length}</span>
      </button>
      {folders.map((folder) => (
        <button
          aria-selected={props.folderId === folder.id}
          className="tab"
          key={folder.id}
          onClick={() => props.onSelect(folder.id)}
          role="tab"
          type="button"
        >
          {folder.name} <span className="n">{count(folder.id)}</span>
        </button>
      ))}
      {listed.isError ? (
        <button
          className="tab text-fail"
          onClick={() => void listed.refetch()}
          title={errorText(listed.error)}
          type="button"
        >
          Folders did not load · Retry
        </button>
      ) : null}
      {mayCreate && adding ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== "" && !create.isPending) create.mutate();
          }}
        >
          <input
            aria-label="Folder name"
            className="field small w-40"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setAdding(false);
            }}
            placeholder="Folder name"
            ref={(node) => node?.focus()}
            value={name}
          />
          <button
            className="btn small"
            disabled={name.trim() === "" || create.isPending}
            type="submit"
          >
            Add
          </button>
          {create.isError ? (
            <span className="t-faint text-fail">{errorText(create.error)}</span>
          ) : null}
        </form>
      ) : null}
      {mayCreate && !adding ? (
        <button className="tab" onClick={() => setAdding(true)} title="New folder" type="button">
          +
        </button>
      ) : null}
      {selected === undefined || selected.refusal !== null ? null : (
        <FolderMenu folder={selected} key={selected.id} onDeleted={() => props.onSelect(null)} />
      )}
    </div>
  );
}

/** Rename or delete the selected folder. Its automations stay, without a folder. */
function FolderMenu(props: { readonly folder: AutomationFolder; readonly onDeleted: () => void }) {
  const confirm = useConfirm();
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState(props.folder.name);
  const rename = useMutation({
    mutationFn: () => api.renameAutomationFolder(props.folder.id, name.trim()),
    onSuccess: () => refreshAll(queryClient),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAutomationFolder(props.folder.id),
    onSuccess: async () => {
      props.onDeleted();
      await refreshAll(queryClient);
    },
  });
  const unchanged = name.trim() === "" || name.trim() === props.folder.name;
  return (
    <>
      <Menu
        alignStart
        bodyClassName="grid gap-2"
        button="⋯"
        buttonClassName="tab"
        label="Folder actions"
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!unchanged && !rename.isPending) rename.mutate();
          }}
        >
          <input
            aria-label="Folder name"
            className="field"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <button className="btn small" disabled={unchanged || rename.isPending} type="submit">
            Rename
          </button>
        </form>
        <button
          className="btn danger small justify-self-start"
          disabled={remove.isPending}
          onClick={async () => {
            const question = `Delete the folder ${props.folder.name}? Its automations stay.`;
            if (await confirm({ action: "Delete folder", question })) remove.mutate();
          }}
          type="button"
        >
          Delete folder
        </button>
        {rename.isError ? <ActionError error={rename.error} /> : null}
      </Menu>
      {/* Outside the menu: the confirmation dialog's click closes it before the answer arrives. */}
      {remove.isError ? (
        <span className="t-faint text-fail" role="alert">
          {errorText(remove.error)}
        </span>
      ) : null}
    </>
  );
}

function RecentlyChanged({ changes }: { readonly changes: Overview["recentChanges"] }) {
  const now = useNow();
  return (
    <>
      <SectionHead title="Recently changed">
        <span className="t-faint">last 7 days</span>
      </SectionHead>
      <div className="card rows overflow-hidden" data-testid="recently-changed">
        {changes.map((change) => (
          <Link
            className="crow hover:bg-surface-2"
            key={change.id}
            params={{ automationSlug: change.automationSlug }}
            search={{ tab: "versions" }}
            to="/automations/$automationSlug"
          >
            <b className="truncate font-medium">{change.automationName}</b>
            <span className="t-meta">
              {changeInWords(change.change).verb}{" "}
              <span>{changeInWords(change.change).versions}</span>
            </span>
            <span className="t-faint text-right">{ageInWords(change.occurredAt, now)}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

const EXAMPLE_PROMPT =
  "Build a Swizzle automation that emails me every Monday at 9 which invoices are still open.";

function EmptyInstance() {
  const { environment } = useDashboardClient();
  return (
    <Page description={environment} title="Nothing runs here yet" type="overview">
      <div data-testid="status-card">
        <FirstSteps />
      </div>
    </Page>
  );
}

/** The three steps to a first automation, or for someone who may not deploy, what it needs. */
function FirstSteps() {
  const overview = useOverview();
  if (overview.isError) {
    return (
      <ErrorNote
        error={overview.error}
        onRetry={() => void overview.refetch()}
        title="The status could not be loaded"
      />
    );
  }
  if (overview.data === undefined) {
    return (
      <div className="card">
        <Skeleton label="Loading the status" lines={3} />
      </div>
    );
  }
  if (overview.data.deploy !== null) {
    return (
      <>
        <p className="m-0">
          An automation shows up here with its health, its trigger and its next run once someone
          deploys it.
        </p>
        <p className="t-meta mt-1" data-testid="refused-controls">
          {refusedControlsInWords([{ label: "Deploy", refusal: overview.data.deploy }])}
        </p>
      </>
    );
  }
  return (
    <>
      <p className="m-0">
        Your agent writes the automations. Three steps until the first one runs.
      </p>
      <div className="steps3" data-testid="empty-steps">
        <div className="card step">
          <div className="num">1</div>
          <h3>Connect your agent</h3>
          <p className="t-meta">
            Create a token. You get one block to paste into your agent's terminal.
          </p>
          <Link className="btn mt-3" params={{ section: "agent-access" }} to="/settings/$section">
            Create agent token
          </Link>
        </div>
        <div className="card step">
          <div className="num">2</div>
          <h3>Ask your agent</h3>
          <p className="t-meta">Describe the result you want, for example:</p>
          <div className="screen mt-2">{EXAMPLE_PROMPT}</div>
          <CopyButton className="btn quiet small mt-2" label="Copy prompt" text={EXAMPLE_PROMPT} />
        </div>
        <div className="card step">
          <div className="num">3</div>
          <h3>It appears here</h3>
          <p className="t-meta">
            When the agent deploys, the automation shows up on this page with its health, its
            trigger and its next run.
          </p>
        </div>
      </div>
    </>
  );
}
