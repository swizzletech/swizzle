import { AuditHistory } from "../components/audit-history";
import { useConfirm } from "../components/confirm";
// One automation `/automations/:slug`: health, description and trigger in words, then its runs
// under the live track and beside the selected run, About (README, flow, trigger, what it needs,
// API check, vars), Play (the deployed code with a run moving through it) and Versions.

import { stepFamily } from "@swizzle/config/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { ActionError, ConnectLink, SecretField } from "../components/actions";
import { AutomationPlay } from "../components/automation-play";
import { FlowDiagram } from "../components/flow-diagram";
import { FlowTrack, useTrackFolded } from "../components/flow-track";
import { MarkdownDocument } from "../components/markdown-document";
import { Menu } from "../components/menu";
import { Page, type PageType } from "../components/page";
import { RunPanel } from "../components/run-panel";
import { RunWorkbench, useRunSplit } from "../components/run-workbench";
import { Track } from "../components/track";
import { Chip, Dot, ErrorNote, Skeleton, useNow, WithCode } from "../components/ui";
import { type AutomationDetail, isOpenRun, type TriggerSummary } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { refreshAll, useFolders } from "../lib/queries";
import { AUTOMATION_TABS, type AutomationSearch, type AutomationTab } from "../lib/search";
import { staticTrack } from "../lib/track";
import { useAutomationFlow } from "../lib/use-automation-flow";
import { useRunPages } from "../lib/use-run-pages";
import { refusedControlsInWords } from "../lib/words/access";
import { CHECK_STATUS } from "../lib/words/api-checks";
import { automationHealth, HEALTH_TONE, readinessInWords } from "../lib/words/health";
import { versionInWords } from "../lib/words/runs";
import { ageInWords, durationInWords } from "../lib/words/time";
import { chainSourcesInWords, nextRunInWords, triggerInWords } from "../lib/words/triggers";

const TAB_LABEL: Record<AutomationTab, string> = {
  about: "About",
  play: "Play",
  runs: "Runs",
  versions: "Versions",
};

const TAB_PAGE: Record<AutomationTab, PageType> = {
  about: "reading",
  play: "reading",
  runs: "workbench",
  versions: "administration",
};

const OVERVIEW = { label: "Overview", to: "/" } as const;

export function AutomationPage() {
  const { automationSlug: slug } = useParams({ from: "/automations/$automationSlug" });
  const search = useSearch({ from: "/automations/$automationSlug" });
  const { api, queryScope } = useDashboardClient();
  const detailQuery = useQuery({
    queryFn: () => api.getAutomationDetail(slug),
    queryKey: ["automation", slug, ...queryScope],
    refetchInterval: 15_000,
  });

  if (detailQuery.isError) {
    return (
      <Page path={{ current: slug, parent: OVERVIEW }} title={slug} type="reading">
        <ErrorNote
          error={detailQuery.error}
          onRetry={() => void detailQuery.refetch()}
          title="This automation could not be loaded"
        />
      </Page>
    );
  }
  if (detailQuery.data === undefined) {
    return (
      <Page path={{ current: slug, parent: OVERVIEW }} title={slug} type="reading">
        <div className="card">
          <Skeleton label="Loading the automation" lines={5} />
        </div>
      </Page>
    );
  }
  return <LoadedAutomation automation={detailQuery.data} search={search} />;
}

function LoadedAutomation(props: {
  readonly automation: AutomationDetail;
  readonly search: AutomationSearch;
}) {
  const { automation } = props;
  const navigate = useNavigate({ from: "/automations/$automationSlug" });
  const tab = props.search.tab ?? "runs";
  return (
    <Page
      actions={<HeadActions automation={automation} />}
      description={<HeadFacts automation={automation} />}
      path={{ current: automation.automationName, parent: OVERVIEW }}
      tabs={
        <div aria-label="Automation" className="dtabs" role="tablist">
          {AUTOMATION_TABS.map((key) => (
            <button
              aria-selected={tab === key}
              className="dtab"
              key={key}
              onClick={() => void navigate({ search: key === "runs" ? {} : { tab: key } })}
              role="tab"
              type="button"
            >
              {TAB_LABEL[key]}
            </button>
          ))}
        </div>
      }
      title={
        <span className="inline-flex items-center gap-2">
          <Dot tone={HEALTH_TONE[automationHealth(automation)]} />
          {automation.automationName}
        </span>
      }
      type={TAB_PAGE[tab]}
    >
      {tab === "runs" ? <RunsTab automation={automation} selected={props.search.run} /> : null}
      {tab === "about" ? <AboutTab automation={automation} /> : null}
      {tab === "play" ? (
        <AutomationPlay
          automation={automation}
          onSelectRun={(runId) => void navigate({ search: { run: runId, tab: "play" } })}
          runId={props.search.run}
        />
      ) : null}
      {tab === "versions" ? <VersionsTab automation={automation} /> : null}
    </Page>
  );
}

/** What the trigger does and where the deployment stands, in the page head under the title. */
function HeadFacts({ automation }: { readonly automation: AutomationDetail }) {
  const now = useNow();
  const trigger = automation.trigger;
  const deployment = automation.activeDeployment;
  const { readiness } = deployment;
  return (
    <div className="grid gap-1">
      {automation.description ? <p className="m-0">{automation.description}</p> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <WithCode text={triggerInWords(trigger)} />
        </span>
        <span>
          {versionInWords(deployment.version)} deployed {ageInWords(deployment.deployedAt, now)}
        </span>
        {trigger?.status === "paused" ? (
          <Chip tone="idle">Paused</Chip>
        ) : (
          <span>{nextRunInWords(trigger, now)}</span>
        )}
        {readiness.status === "not-ready" ? (
          <span title={readiness.errors.map((issue) => issue.message).join("\n")}>
            <Chip tone="warn">{readinessInWords(readiness)}</Chip>
          </span>
        ) : null}
      </div>
      {readiness.warnings.map((issue) => (
        <p className="m-0" key={`${issue.code}:${issue.worker}:${issue.subject}`}>
          {issue.message}
        </p>
      ))}
    </div>
  );
}

function HeadActions({ automation }: { readonly automation: AutomationDetail }) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const trigger = automation.trigger;
  const { refusals } = automation;
  const runs = trigger !== null && trigger.triggerType !== "chain";
  const toggles = trigger !== null && trigger.status !== "invalid";
  const refused = [
    ...(runs && refusals.run !== null ? [{ label: "Run now", refusal: refusals.run }] : []),
    ...(toggles && refusals.edit !== null
      ? [{ label: trigger.status === "paused" ? "Resume" : "Pause", refusal: refusals.edit }]
      : []),
    ...(refusals.organize === null
      ? []
      : [{ label: "Move to folder", refusal: refusals.organize }]),
  ];
  const toggle = useMutation({
    mutationFn: () =>
      trigger?.status === "paused"
        ? api.resumeTrigger(automation.automationSlug)
        : api.pauseTrigger(automation.automationSlug),
    onSuccess: () => refreshAll(queryClient),
  });
  return (
    <>
      {toggle.isError ? <ActionError error={toggle.error} /> : null}
      {refused.length === 0 ? null : (
        <p className="t-faint m-0 max-w-80" data-testid="refused-controls">
          {refusedControlsInWords(refused)}
        </p>
      )}
      {runs && refusals.run === null ? <RunNow automation={automation} trigger={trigger} /> : null}
      {toggles && refusals.edit === null ? (
        <button
          className="btn quiet"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
          type="button"
        >
          {trigger.status === "paused" ? "Resume" : "Pause"}
        </button>
      ) : null}
      {refusals.organize === null ? <MoreMenu automation={automation} /> : null}
    </>
  );
}

/** Run now, with an optional JSON payload; the new run opens in the Runs tab. */
function RunNow(props: {
  readonly automation: AutomationDetail;
  readonly trigger: TriggerSummary;
}) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: "/automations/$automationSlug" });
  const [payload, setPayload] = useState("");
  const start = useMutation({
    mutationFn: () => api.startRun(props.automation.automationSlug, parsePayload(payload)),
    onSuccess: async (started) => {
      setPayload("");
      await navigate({ search: { run: started.runId } });
      await refreshAll(queryClient);
    },
  });
  return (
    <Menu bodyClassName="grid w-[320px] gap-2" button="Run now" buttonClassName="btn">
      <label className="form-label">
        Payload (optional JSON)
        <textarea
          className="field"
          onChange={(event) => setPayload(event.target.value)}
          placeholder="{}"
          rows={4}
          value={payload}
        />
      </label>
      <button
        className="btn"
        disabled={start.isPending}
        onClick={() => start.mutate()}
        type="button"
      >
        {start.isPending ? "Starting…" : "Start run"}
      </button>
      {start.isError ? <ActionError error={start.error} /> : null}
    </Menu>
  );
}

function parsePayload(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The payload is not valid JSON.");
  }
}

/** The "⋯" menu: Move to folder. Delete stays in the CLI. */
function MoreMenu({ automation }: { readonly automation: AutomationDetail }) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  // Only folders of the automation's own project take it.
  const folders = useFolders().data?.folders.filter(
    (folder) => folder.projectId === automation.projectId,
  );
  const move = useMutation({
    mutationFn: (folderId: string | null) =>
      api.assignAutomationFolder(automation.automationSlug, folderId),
    onSuccess: () => refreshAll(queryClient),
  });
  return (
    <Menu button="⋯" buttonClassName="btn quiet" label="More">
      <label className="form-label">
        Move to folder
        <select
          className="field"
          disabled={move.isPending}
          onChange={(event) => move.mutate(event.target.value === "" ? null : event.target.value)}
          value={automation.folderId ?? ""}
        >
          <option value="">No folder</option>
          {(folders ?? []).map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </label>
      {move.isError ? <ActionError error={move.error} /> : null}
    </Menu>
  );
}

function RunsTab(props: {
  readonly automation: AutomationDetail;
  readonly selected: string | undefined;
}) {
  const { api, queryScope } = useDashboardClient();
  const navigate = useNavigate({ from: "/automations/$automationSlug" });
  const slug = props.automation.automationSlug;
  const pages = useRunPages({ automation: slug });
  // As on Runs. On a phone the chosen run comes first and its track below it, since a phone draws
  // the track a screen tall.
  const view = useRunSplit(props.selected, pages.runs?.[0]?.runId);
  const { selected } = view;
  const select = (runId: string, options?: { readonly replace: boolean }) =>
    void navigate({ replace: options?.replace ?? false, search: { run: runId } });
  const runQuery = useQuery({
    enabled: selected !== undefined,
    queryFn: () => api.getRunDetail(selected ?? ""),
    // The run panel reads the same key, so the run is fetched once.
    queryKey: ["run", selected, ...queryScope],
    refetchInterval: (query) =>
      query.state.data !== undefined && isOpenRun(query.state.data.status) ? 3_000 : false,
  });
  const run = selected === undefined ? null : (runQuery.data ?? null);
  // The track and the code of the deployment the run ran on, not of whatever is active now.
  const flow = useAutomationFlow(
    slug,
    run?.deploymentId ?? props.automation.activeDeployment.deploymentId,
  );
  const [folded, setFolded] = useTrackFolded();
  // The station decides the approval only when it is on screen above the panel; on a phone with a
  // run chosen the track sits below the panel, so the panel decides. Track and panel read this one
  // answer, so exactly one of them shows Approve and Reject.
  const approvalOnTrack = (stepKey: string) =>
    view.list &&
    !folded &&
    (flow.graph?.nodes.some((node) => node.id === stepFamily(stepKey)) ?? false);

  return (
    <RunWorkbench
      band={
        <FlowTrack
          approvalOnTrack={approvalOnTrack}
          flow={flow}
          folded={folded}
          onFold={setFolded}
          run={run}
        />
      }
      empty="No runs yet. Start one with Run now, or wait for its trigger."
      leads="state"
      listEnd={
        <Link className="linkish t-faint" search={{ automation: slug }} to="/runs">
          All runs of {props.automation.automationName} →
        </Link>
      }
      onBack={() => void navigate({ search: ({ run: _run, ...previous }) => previous })}
      onSelect={select}
      pages={pages}
      run={(runId) => (
        <RunPanel
          approvalOnTrack={approvalOnTrack}
          onSelectRun={select}
          runId={runId}
          showAutomationLink={false}
        />
      )}
      view={view}
    />
  );
}

function AboutTab({ automation }: { readonly automation: AutomationDetail }) {
  const { api, queryScope } = useDashboardClient();
  const slug = automation.automationSlug;
  const readme = useQuery({
    queryFn: () => api.getAutomationReadme(slug),
    queryKey: ["readme", slug, ...queryScope],
  });
  const flow = useAutomationFlow(slug, automation.activeDeployment.deploymentId);
  const vars = Object.entries(automation.activeDeployment.vars);
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* A one-column track that may shrink, so a long README line scrolls instead of spilling. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        <div className="card p-6">
          <MarkdownDocument
            available={readme.data?.available ?? false}
            content={readme.data?.content ?? null}
            error={readme.error?.message ?? readme.data?.error ?? null}
            loading={readme.isLoading}
          />
        </div>
        {/* A flowchart is drawn as the track with reach counts; any other diagram by Mermaid. */}
        {flow.graph !== null ? (
          <AboutCard title="Flow">
            <Track testId="track" track={staticTrack(flow.graph, flow.families, flow.reach)} />
          </AboutCard>
        ) : flow.mermaid !== null && !flow.pending ? (
          <AboutCard title="Flow">
            <FlowDiagram code={flow.mermaid} />
          </AboutCard>
        ) : null}
        {flow.mermaidError === null ? null : (
          <AboutCard title="Flow">
            <ErrorNote error={flow.mermaidError} title="The flow diagram could not be read" />
          </AboutCard>
        )}
      </div>
      <div className="grid gap-6">
        <AboutCard title="Trigger">
          <TriggerFacts trigger={automation.trigger} />
        </AboutCard>
        <AboutCard title="Needs">
          <Needs automation={automation} />
        </AboutCard>
        <AboutCard title="API check">
          <ApiCheckFacts automation={automation} />
        </AboutCard>
        {vars.length > 0 ? (
          <AboutCard title="Vars">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
              {vars.map(([name, value]) => (
                <Fact key={name} label={<span className="mono">{name}</span>}>
                  <span className="mono">{String(value)}</span>
                </Fact>
              ))}
            </dl>
          </AboutCard>
        ) : null}
      </div>
    </div>
  );
}

function AboutCard(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="t-section mb-2">{props.title}</h2>
      {props.children}
    </section>
  );
}

function Fact(props: { readonly label: ReactNode; readonly children: ReactNode }) {
  return (
    <>
      <dt className="t-meta">{props.label}</dt>
      <dd className="m-0 min-w-0">{props.children}</dd>
    </>
  );
}

function TriggerFacts({ trigger }: { readonly trigger: TriggerSummary | null }) {
  const now = useNow();
  if (trigger === null) return <p className="t-meta">This automation has no trigger</p>;
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Fact label="Runs">
          <WithCode text={triggerInWords(trigger)} />
        </Fact>
        {trigger.webhookUrl === null ? null : (
          <Fact label="Webhook URL">
            <span className="mono">{trigger.webhookUrl}</span>
          </Fact>
        )}
        {trigger.cronSchedule === null ? null : (
          <Fact label="Schedule">
            <span className="mono">{trigger.cronSchedule}</span> (UTC)
          </Fact>
        )}
        {trigger.triggerType === "chain" ? (
          <Fact label="After">{chainSourcesInWords(trigger).join(", ")}</Fact>
        ) : null}
        <Fact label="Next">
          {trigger.status === "paused" ? "Paused" : nextRunInWords(trigger, now)}
        </Fact>
      </dl>
      {trigger.status === "invalid" ? (
        <p className="errbox mt-3 text-[13px]">
          <b>The trigger does not work.</b> {trigger.errorMessage}
        </p>
      ) : null}
    </>
  );
}

/**
 * How config.yaml's `api_check` watches the automation's API: the level, an active check's latest
 * and last green output with the calls it says it made, and what its runs saw of each host.
 */
function ApiCheckFacts({ automation }: { readonly automation: AutomationDetail }) {
  const now = useNow();
  const { apiCheck, apiContacts } = automation;
  const record = apiCheck?.mode === "active" ? apiCheck.record : null;
  const checked = record?.lastGreenReport?.checked ?? [];
  return (
    <div className="grid gap-3" data-testid="api-check">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Fact label="Level">
          {apiCheck === null
            ? "None: it reaches no outside API through a secret or an account."
            : null}
          {apiCheck?.mode === "off" ? <>Off: {apiCheck.reason}</> : null}
          {apiCheck?.mode === "passive"
            ? `Passive: learns from real runs, untested after ${durationInWords(apiCheck.untestedAfterMs)} without a call`
            : null}
          {apiCheck?.mode === "active" ? (
            <>
              Active: <span className="mono">{apiCheck.entrypoint}</span> every{" "}
              {durationInWords(apiCheck.everyMs)} and after each deploy
            </>
          ) : null}
        </Fact>
        {apiCheck?.mode === "active" && apiCheck.secrets !== null ? (
          <Fact label="Secrets">
            <span className="mono">{apiCheck.secrets.join(", ") || "none"}</span>
          </Fact>
        ) : null}
        {apiCheck?.mode === "active" ? (
          <>
            <Fact label="Result">
              <Chip tone={CHECK_STATUS[record?.status ?? "pending"].tone}>
                {CHECK_STATUS[record?.status ?? "pending"].label}
              </Chip>
              {record?.lastCheckedAt ? ` ${ageInWords(record.lastCheckedAt, now)}` : null}
            </Fact>
            {record === null ? null : (
              <Fact label="Last green">
                {record.lastGreenAt === null ? "never" : ageInWords(record.lastGreenAt, now)}
              </Fact>
            )}
            {checked.length > 0 ? (
              <Fact label="Checks">
                <span className="mono">{checked.join(", ")}</span>
              </Fact>
            ) : null}
          </>
        ) : null}
      </dl>
      {record?.lastWarning ? <p className="t-meta">{record.lastWarning}</p> : null}
      {record !== null && record.status !== "green" && record.lastCheckedAt !== null ? (
        <>
          {record.lastOutput !== null || record.lastStderrTail === null ? (
            <pre className="screen max-h-[220px] whitespace-pre-wrap break-all">
              {record.lastOutput ?? "The check printed nothing"}
            </pre>
          ) : null}
          {record.lastStderrTail === null ? null : (
            <pre className="screen max-h-[220px] whitespace-pre-wrap break-all">
              <span className="c">stderr: </span>
              {record.lastStderrTail}
            </pre>
          )}
          {record.lastGreenOutput === null ? null : (
            <pre className="screen max-h-[220px] whitespace-pre-wrap break-all">
              <span className="c">last green: </span>
              {record.lastGreenOutput}
            </pre>
          )}
        </>
      ) : null}
      {apiContacts.map((contact) => (
        <div className="flex items-center justify-between gap-2" key={contact.host}>
          <span className="min-w-0">
            <span className="mono">{contact.host}</span>
            <span className="t-faint">
              {" "}
              · {contact.lastStatus} {ageInWords(contact.lastContactAt, now)}
            </span>
          </span>
          {contact.sunsetAt !== null || contact.deprecatedAt !== null ? (
            <Chip tone="warn">
              {contact.sunsetAt === null ? "Deprecated" : `Sunset ${contact.sunsetAt.slice(0, 10)}`}
            </Chip>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A secret set since the deploy reaches the runs only once a deploy binds it. */
const SECRET_CHIP = { bound: "Set", missing: "Missing", unbound: "Deploy again" } as const;

/** The secrets and accounts config.yaml declares, each with its state and the field to fix it. */
function Needs({ automation }: { readonly automation: AutomationDetail }) {
  if (automation.requiredSecrets.length === 0 && automation.requiredConnections.length === 0) {
    return <p className="t-meta">It needs no secrets or accounts</p>;
  }
  return (
    <div className="grid gap-3">
      {automation.requiredSecrets.map((secret) => (
        <div className="grid gap-2" key={secret.name}>
          <div className="flex items-center justify-between gap-2">
            <span className="mono">{secret.name}</span>
            <Chip tone={secret.state === "bound" ? "ok" : "warn"}>{SECRET_CHIP[secret.state]}</Chip>
          </div>
          {secret.state !== "missing" ? null : (
            <div className="flex flex-wrap items-center gap-2 [&_.field]:min-w-0 [&_.field]:flex-1">
              <SecretField name={secret.name} projectId={automation.projectId} />
            </div>
          )}
        </div>
      ))}
      {automation.requiredConnections.map((connection) => (
        <div className="flex items-center justify-between gap-2" key={connection.name}>
          <span>
            <span className="mono">{connection.name}</span>
            {connection.provider === null ? null : (
              <span className="t-faint"> · {connection.provider}</span>
            )}
          </span>
          <ConnectionState connection={connection} projectId={automation.projectId} />
        </div>
      ))}
    </div>
  );
}

/** A connected account reaches the runs only once a deploy binds it. */
function ConnectionState(props: {
  readonly connection: AutomationDetail["requiredConnections"][number];
  readonly projectId: string;
}) {
  const { connection } = props;
  if (connection.status === "active") return <Chip tone="ok">Connected</Chip>;
  if (connection.status === "unbound") return <Chip tone="warn">Deploy again</Chip>;
  return (
    <ConnectLink
      name={connection.name}
      projectId={props.projectId}
      provider={connection.provider}
    />
  );
}

/** "Rolled back to v1.2.0", "Deployed v1.1.0 → v1.2.0" or "Deployed v1.0.0". */
function deploymentInWords(
  version: string,
  event: AutomationDetail["deploymentAudit"][number] | undefined,
): string {
  const shown = versionInWords(version);
  if (event?.change.eventType === "rollback") return `Rolled back to ${shown}`;
  if (event?.change.previousVersion) {
    return `Deployed ${versionInWords(event.change.previousVersion)} → ${shown}`;
  }
  return `Deployed ${shown}`;
}

/**
 * One timeline of deploys and rollbacks, newest first, with Roll back on every older entry unless
 * the viewer's role refuses it; then it says why once.
 */
function VersionsTab({ automation }: { readonly automation: AutomationDetail }) {
  const confirm = useConfirm();
  const now = useNow();
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const rollback = useMutation({
    mutationFn: (deploymentId: string) =>
      api.rollbackDeployment(automation.automationSlug, deploymentId),
    onSuccess: () => refreshAll(queryClient),
  });
  const events = new Map(
    automation.deploymentAudit.map((event) => [event.change.deploymentId, event]),
  );
  const bySeq = [...automation.deploymentHistory].sort((a, b) => b.seq - a.seq);
  const activeId = automation.activeDeployment.deploymentId;
  const refusal = automation.refusals.edit;
  return (
    <>
      {refusal !== null && bySeq.length > 1 ? (
        <p className="t-meta m-0" data-testid="refused-controls">
          {refusedControlsInWords([{ label: "Roll back", refusal }])}
        </p>
      ) : null}
      <div className="card rows overflow-hidden" data-testid="versions">
        {bySeq.map((deployment) => {
          const event = events.get(deployment.deploymentId);
          const verb = deploymentInWords(deployment.version, event);
          return (
            <div className="setting" key={deployment.deploymentId}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono t-faint">#{deployment.seq}</span>
                  <b>{verb}</b>
                  {deployment.deploymentId === activeId ? <Chip tone="ok">Live</Chip> : null}
                </div>
                <div className="t-faint mt-1">
                  {ageInWords(deployment.deployedAt, now)} ·{" "}
                  {new Date(deployment.deployedAt).toLocaleString("en-GB")} ·{" "}
                  <span className="mono">{deployment.sourceHash.slice(0, 12)}</span>
                </div>
              </div>
              {deployment.deploymentId === activeId || refusal !== null ? null : (
                <button
                  className="btn quiet small"
                  disabled={rollback.isPending}
                  onClick={async () => {
                    const question = `Roll ${automation.automationName} back to #${deployment.seq} (${versionInWords(deployment.version)})?`;
                    if (await confirm({ action: "Roll back", question })) {
                      rollback.mutate(deployment.deploymentId);
                    }
                  }}
                  type="button"
                >
                  Roll back to this
                </button>
              )}
            </div>
          );
        })}
        {rollback.isError ? (
          <div className="px-4 py-3">
            <ActionError error={rollback.error} />
          </div>
        ) : null}
      </div>
      <AuditHistory automation={automation.automationSlug} />
    </>
  );
}
