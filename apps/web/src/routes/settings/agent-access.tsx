// Settings › Agent access (#agent-access): the signed-in person's agent tokens, created with a
// scope and shown once.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ActionError } from "../../components/actions";
import { useConfirm } from "../../components/confirm";
import { type Scope, ScopeFields, scopeInput } from "../../components/scope-fields";
import { CopyButton, ErrorNote, Skeleton, useNow } from "../../components/ui";
import type { CreatedApiToken, ProjectRole } from "../../lib/api";
import { publicApiUrl } from "../../lib/api/request";
import { useDashboardClient } from "../../lib/dashboard-client";
import { refreshAll, useProjects } from "../../lib/queries";
import { scopeInWords } from "../../lib/words/access";
import { ageInWords, expiryInWords } from "../../lib/words/time";
import { SECTION_DATA, Section } from "./section";

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
    meta: SECTION_DATA,
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
      id="agent-access"
      intro="A token lets your agent deploy and operate automations through the swizzle CLI. Use one token per agent or device, so you can revoke each on its own."
      title="Agent access"
    >
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
