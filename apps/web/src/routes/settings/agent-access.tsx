// Settings › Agent access (`/settings/agent-access`): the one place to connect an agent. It sets
// the two identities an agent can act as side by side: an agent token, which acts as the signed-in
// person and is made here with a scope and shown once, and a project's service account, which the
// project's admins make on its Service accounts tab, linked from here.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ActionError } from "../../components/actions";
import { useConfirm } from "../../components/confirm";
import { type Scope, ScopeFields, scopeInput } from "../../components/scope-fields";
import { CopyButton, ErrorNote, Skeleton, useNow } from "../../components/ui";
import type { CreatedApiToken, Project, ProjectRole } from "../../lib/api";
import { publicApiUrl } from "../../lib/api/request";
import { useDashboardClient } from "../../lib/dashboard-client";
import { refreshAll, useProjects } from "../../lib/queries";
import { scopeInWords } from "../../lib/words/access";
import { ageInWords, expiryInWords } from "../../lib/words/time";
import { Section } from "./section";

const DAY_MS = 24 * 60 * 60 * 1000;

const TOKEN_ROLES: readonly ProjectRole[] = ["viewer", "operator", "editor", "admin"];

const FULL_SCOPE: Scope = { environments: new Set(), projects: new Set(), role: "admin" };

export function AgentAccess() {
  const confirm = useConfirm();
  const { api, queryScope } = useDashboardClient();
  const queryClient = useQueryClient();
  const now = useNow();
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [scope, setScope] = useState<Scope>(FULL_SCOPE);
  const projects = useProjects();
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  // The browser keeps a page it leaves in the back/forward cache, state and all, and Back shows
  // it again. Dropping the token before the page is hidden keeps the promise to show it once.
  // A creation still in flight answers in the cached page, so it shows its token only when the
  // page was not hidden since the request started.
  const pageHides = useRef(0);
  useEffect(() => {
    const forget = () => {
      pageHides.current += 1;
      flushSync(() => setCreated(null));
    };
    window.addEventListener("pagehide", forget);
    return () => window.removeEventListener("pagehide", forget);
  }, []);
  const tokens = useQuery({
    queryFn: async () => (await api.listApiTokens()).tokens,
    queryKey: ["tokens", ...queryScope],
  });
  const create = useMutation({
    // The token goes to this component's state alone, never into the mutation cache.
    mutationFn: async () => {
      const hidesBefore = pageHides.current;
      const token = await api.createApiToken({
        expiresAt: new Date(Date.now() + Number(days) * DAY_MS).toISOString(),
        name: name.trim(),
        scope: scopeInput(scope),
      });
      if (pageHides.current === hidesBefore) setCreated(token);
    },
    onSuccess: async () => {
      setName("");
      setScope(FULL_SCOPE);
      await refreshAll(queryClient);
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiToken(id),
    onSuccess: () => refreshAll(queryClient),
  });
  const active = (tokens.data ?? []).filter((token) => token.revokedAt === null);

  return (
    <Section
      intro="Connect a coding agent, a script or CI to this instance through the swizzle CLI. Choose who it acts as."
      title="Agent access"
    >
      <div className="mb-6 grid gap-3.5 md:grid-cols-2" data-testid="agent-identities">
        <div className="card px-5 py-4">
          <h2 className="t-section">As you: agent token</h2>
          <p className="t-meta mt-1">
            Use an agent token when the agent works for you. It acts with your rights at most and
            stops when you lose them.
          </p>
        </div>
        <ServiceAccountsDoor projects={projects} />
      </div>
      <div className="sec-head">
        <h2 className="t-section">Your agent tokens</h2>
        <p className="t-meta mt-1">
          Use one token per agent or device, so you can revoke each on its own.
        </p>
      </div>
      {created === null ? null : <GiveToAgent onDismiss={() => setCreated(null)} token={created} />}
      <div className="card rows overflow-hidden">
        <form
          className="setting-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== "" && !create.isPending) create.mutate();
          }}
        >
          <label className="form-label min-w-0 flex-1">
            Token name
            <input
              autoComplete="off"
              className="field"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Claude on my laptop"
              value={name}
            />
          </label>
          <label className="form-label">
            Expires after
            <select
              className="field"
              onChange={(event) => setDays(event.target.value)}
              value={days}
            >
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </select>
          </label>
          <button className="btn" disabled={name.trim() === "" || create.isPending} type="submit">
            {create.isPending ? "Creating…" : "Create agent token"}
          </button>
          <details className="basis-full">
            <summary className="t-meta cursor-pointer">
              Limit what it may do. Without a limit it acts with all your rights.
            </summary>
            <div className="mt-2">
              {projects.isError ? (
                <ErrorNote
                  error={projects.error}
                  title="The projects could not be loaded, so this token cannot be limited to some of them yet."
                />
              ) : null}
              <ScopeFields
                onChange={setScope}
                projects={projects.data ?? []}
                roles={TOKEN_ROLES}
                value={scope}
              />
              <span className="t-faint mt-2 block">
                A token never does more than your own roles allow, and its limit is fixed once
                created.
              </span>
            </div>
          </details>
          {create.isError ? <ActionError error={create.error} /> : null}
        </form>
        {tokens.isError ? (
          <div className="p-4">
            <ErrorNote error={tokens.error} title="The tokens could not be loaded." />
          </div>
        ) : tokens.data === undefined ? (
          <Skeleton label="Loading tokens" lines={2} />
        ) : (
          active.map((token) => (
            <div className="setting" data-testid="token-row" key={token.id}>
              <div className="min-w-0">
                <b>{token.name}</b> <span className="mono t-faint">{token.tokenPrefix}…</span>
                <div className="t-faint">
                  {scopeInWords(token.scope, "person")}
                  {" · "}
                  {token.lastUsedAt === null
                    ? "Never used"
                    : `Used ${ageInWords(token.lastUsedAt, now)}`}
                  {" · "}
                  {expiryInWords(token.expiresAt, now)}
                </div>
              </div>
              <button
                className="btn danger small"
                disabled={revoke.isPending}
                onClick={async () => {
                  const question = `Revoke ${token.name}? The agent using it loses access at once.`;
                  if (await confirm({ action: "Revoke", question })) revoke.mutate(token.id);
                }}
                type="button"
              >
                Revoke
              </button>
            </div>
          ))
        )}
        {revoke.isError ? (
          <div className="px-[18px] py-2">
            <ActionError error={revoke.error} />
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * The other identity an agent can act as. It links to the Service accounts tab of each project the
 * person administers; someone who administers none learns whom to ask, and gets no link to a tab
 * they cannot open.
 */
function ServiceAccountsDoor({ projects }: { readonly projects: ReturnType<typeof useProjects> }) {
  const administered = (projects.data ?? []).filter((project) => project.role === "admin");
  return (
    <div className="card px-5 py-4">
      <h2 className="t-section">As a project: service account</h2>
      <p className="t-meta mt-1">
        Use a service account for CI or an agent that must keep working when you leave.{" "}
        {projects.isSuccess && administered.length === 0
          ? "A project's admins create them; ask one of them."
          : "It belongs to one project and acts at most as editor."}
      </p>
      <ServiceAccountLinks administered={administered} projects={projects} />
    </div>
  );
}

/** Where the person's service accounts live: one link per project they administer. */
function ServiceAccountLinks(props: {
  readonly projects: ReturnType<typeof useProjects>;
  readonly administered: readonly Project[];
}) {
  if (props.projects.isError) {
    return (
      <div className="mt-2">
        <ErrorNote
          error={props.projects.error}
          title="The projects could not be loaded, so their service accounts cannot be listed."
        />
      </div>
    );
  }
  if (props.projects.data === undefined) return <Skeleton label="Loading projects" lines={1} />;
  if (props.administered.length === 0) return null;
  return (
    <p className="t-meta mt-2">
      Service accounts in{" "}
      {props.administered.map((project, index) => (
        <Fragment key={project.id}>
          {index === 0 ? null : ", "}
          <Link
            className="linkish"
            params={{ project: project.slug }}
            search={{ tab: "service-accounts" }}
            to="/projects/$project"
          >
            {project.name}
          </Link>
        </Fragment>
      ))}
    </p>
  );
}

/**
 * The one-time block with the token and the commands that set the agent's CLI up. The agent pastes
 * it where it already works, so the workspace goes into a new folder there.
 */
function GiveToAgent(props: { readonly token: CreatedApiToken; readonly onDismiss: () => void }) {
  const { environment } = useDashboardClient();
  const block = [
    `export SWIZZLE_TOKEN='${props.token.token}'`,
    `swizzle profile add ${environment} --url ${publicApiUrl()} --env ${environment} --token-env SWIZZLE_TOKEN --default`,
    "swizzle doctor",
    "swizzle workspace init ./my-automations",
  ].join("\n");
  return (
    <div className="card mb-3.5 grid gap-3 px-5 py-4" data-testid="give-to-agent">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="t-section">Give this to your agent</h3>
        <span className="t-faint">
          The token is shown only now. Copy the block before you leave.
        </span>
      </div>
      <pre className="screen">{block}</pre>
      <div className="flex flex-wrap gap-2">
        <CopyButton label="Copy block" text={block} />
        <button className="btn quiet" onClick={props.onDismiss} type="button">
          Done
        </button>
      </div>
    </div>
  );
}
