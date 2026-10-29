// A project's service accounts, for its admins: create one, give it roles on the project, an
// automation or an environment (through the share form), mint tokens with a scope, rotate and
// revoke them, and read what the account did in the audit. A token value shows once, and is
// forgotten when the page is hidden, as Settings › Agent access does. Agent access links here for
// every project the person administers, and this tab links back to it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ActionError } from "../components/actions";
import { useConfirm } from "../components/confirm";
import { HolderList } from "../components/holder-list";
import { type Scope, ScopeFields, scopeInput } from "../components/scope-fields";
import { ShareForm, subjectKey } from "../components/share-form";
import { CopyButton, ErrorNote, Skeleton, useNow } from "../components/ui";
import type { CreatedApiToken, ProjectAccess, ServiceAccount, ShareRole } from "../lib/api";
import { publicApiUrl } from "../lib/api/request";
import { useDashboardClient } from "../lib/dashboard-client";
import { scopeInWords } from "../lib/words/access";
import { auditActionInWords } from "../lib/words/audit";
import { ageInWords, expiryInWords } from "../lib/words/time";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_ROLES: readonly ShareRole[] = ["viewer", "operator", "editor"];

export function ServiceAccounts({ access }: { readonly access: ProjectAccess }) {
  const { api, authRevision } = useDashboardClient();
  const queryClient = useQueryClient();
  const project = access.project.slug;
  const [name, setName] = useState("");
  const accounts = useQuery({
    queryFn: () => api.listServiceAccounts(project),
    queryKey: ["service-accounts", project, authRevision],
  });
  const changed = async () => {
    await queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
    await queryClient.invalidateQueries({ queryKey: ["project-access"] });
  };
  const create = useMutation({
    mutationFn: () => api.createServiceAccount(project, name.trim()),
    onSuccess: async () => {
      setName("");
      await changed();
    },
  });
  return (
    <section>
      <div className="sec-head">
        <h2 className="t-section">Service accounts</h2>
        <p className="t-meta">
          An identity of this project for CI or an agent that must keep working when a person
          leaves. It acts as itself, at most as editor, never as whoever made its token. For an
          agent that works for you, use an agent token in{" "}
          <Link className="linkish" params={{ section: "agent-access" }} to="/settings/$section">
            Settings › Agent access
          </Link>{" "}
          instead.
        </p>
      </div>
      <form
        className="card setting mb-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== "" && !create.isPending) create.mutate();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="form-label min-w-0 flex-1">
            Name
            <input
              autoComplete="off"
              className="field"
              onChange={(event) => setName(event.target.value)}
              placeholder="ci-deploy"
              value={name}
            />
          </label>
          {create.isError ? <ActionError error={create.error} /> : null}
        </div>
        <button className="btn" disabled={name.trim() === "" || create.isPending} type="submit">
          {create.isPending ? "Creating…" : "Create service account"}
        </button>
      </form>
      {accounts.isError ? (
        <ErrorNote error={accounts.error} title="The service accounts could not be loaded." />
      ) : accounts.data === undefined ? (
        <div className="card">
          <Skeleton label="Loading service accounts" lines={3} />
        </div>
      ) : accounts.data.length === 0 ? (
        <p className="card t-meta px-5 py-4">This project has no service account yet.</p>
      ) : (
        <div className="grid gap-3.5">
          {accounts.data.map((account) => (
            <Account access={access} account={account} key={account.id} onChanged={changed} />
          ))}
        </div>
      )}
    </section>
  );
}

function Account(props: {
  readonly access: ProjectAccess;
  readonly account: ServiceAccount;
  readonly onChanged: () => Promise<void>;
}) {
  const { access, account } = props;
  const { api } = useDashboardClient();
  const confirm = useConfirm();
  const now = useNow();
  const project = access.project.slug;
  const [sharing, setSharing] = useState(false);
  const holder = access.holders.find(
    (candidate) =>
      subjectKey(candidate.subject) ===
      subjectKey({ kind: "service-account", serviceAccountId: account.id }),
  );
  const remove = useMutation({
    mutationFn: () => api.deleteServiceAccount(project, account.id),
    onSuccess: props.onChanged,
  });
  return (
    <article
      aria-label={`Service account ${account.name}`}
      className="card rows overflow-hidden"
      data-testid="service-account"
    >
      <div className="setting">
        <div className="min-w-0">
          <h3 className="t-section">{account.name}</h3>
          <div className="t-faint">
            Created {ageInWords(account.createdAt, now)} by {account.createdBy.name}. It keeps
            working when the person who made it leaves.
          </div>
        </div>
        <button
          className="btn danger small"
          disabled={remove.isPending}
          onClick={async () => {
            const question = `Delete ${account.name}? Its grants and tokens go with it; what it deployed keeps running.`;
            if (await confirm({ action: "Delete account", question })) remove.mutate();
          }}
          type="button"
        >
          Delete account
        </button>
      </div>
      {remove.isError ? (
        <div className="px-[18px] py-2">
          <ActionError error={remove.error} />
        </div>
      ) : null}
      <div className="grid gap-2 px-[18px] py-3.5">
        <div className="flex flex-wrap items-baseline gap-3">
          <b>What it may do</b>
          <button className="btn quiet small" onClick={() => setSharing(true)} type="button">
            Change rights
          </button>
        </div>
        {holder === undefined ? null : (
          <HolderList access={access} holders={[holder]} onChange={() => setSharing(true)} />
        )}
        {sharing ? (
          <ShareForm
            access={access}
            onDone={() => setSharing(false)}
            subject={{ kind: "service-account", serviceAccountId: account.id }}
          />
        ) : null}
      </div>
      <Tokens account={account} onChanged={props.onChanged} project={project} />
      <AccountAudit account={account} />
    </article>
  );
}

/** The account's tokens, a form to mint one with a scope, and Rotate and Revoke per token. */
function Tokens(props: {
  readonly account: ServiceAccount;
  readonly project: string;
  readonly onChanged: () => Promise<void>;
}) {
  const { account, project } = props;
  const { api } = useDashboardClient();
  const confirm = useConfirm();
  const now = useNow();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>({
    environments: new Set(),
    projects: new Set(),
    role: "editor",
  });
  const [days, setDays] = useState("90");
  const [shown, setShown] = useState<CreatedApiToken | null>(null);
  // A page the browser keeps in its back/forward cache must not show the value again on Back.
  const pageHides = useRef(0);
  useEffect(() => {
    const forget = () => {
      pageHides.current += 1;
      flushSync(() => setShown(null));
    };
    window.addEventListener("pagehide", forget);
    return () => window.removeEventListener("pagehide", forget);
  }, []);
  const once = async (mint: () => Promise<CreatedApiToken>) => {
    const hidesBefore = pageHides.current;
    const token = await mint();
    if (pageHides.current === hidesBefore) setShown(token);
    await props.onChanged();
  };
  const create = useMutation({
    mutationFn: () =>
      once(() =>
        api.createServiceAccountToken(project, account.id, {
          expiresAt: new Date(Date.now() + Number(days) * DAY_MS).toISOString(),
          name: name.trim(),
          scope: scopeInput(scope),
        }),
      ),
    onSuccess: () => setName(""),
  });
  const rotate = useMutation({
    mutationFn: (tokenId: string) =>
      once(() => api.rotateServiceAccountToken(project, account.id, tokenId)),
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => api.revokeServiceAccountToken(project, account.id, tokenId),
    onSuccess: props.onChanged,
  });
  const live = account.tokens.filter((token) => token.revokedAt === null);
  const error = create.error ?? rotate.error ?? revoke.error;

  return (
    <div className="grid gap-3 px-[18px] py-3.5">
      <b>Tokens</b>
      {shown === null ? null : (
        <div className="grid gap-2" data-testid="service-token">
          <span className="t-faint">
            The value of {shown.name} shows only now. Store it in your CI's secret store.
          </span>
          <pre className="screen">{`SWIZZLE_URL=${publicApiUrl()}\nSWIZZLE_TOKEN=${shown.token}`}</pre>
          <div className="flex flex-wrap gap-2">
            <CopyButton label="Copy token" text={shown.token} />
            <button className="btn quiet" onClick={() => setShown(null)} type="button">
              Done
            </button>
          </div>
        </div>
      )}
      {live.length === 0 ? <span className="t-meta">No live token.</span> : null}
      {live.map((token) => (
        <div className="setting px-0 py-1" data-testid="service-token-row" key={token.id}>
          <div className="min-w-0">
            <b>{token.name}</b> <span className="mono t-faint">{token.tokenPrefix}…</span>
            <div className="t-faint">
              {scopeInWords(token.scope, "service-account")} ·{" "}
              {token.lastUsedAt === null
                ? "never used"
                : `used ${ageInWords(token.lastUsedAt, now)}`}{" "}
              · {expiryInWords(token.expiresAt, now)}
              {token.issuedBy === null ? "" : ` · issued by ${token.issuedBy.name}`}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className="btn quiet small"
              disabled={rotate.isPending}
              onClick={async () => {
                const question = `Rotate ${token.name}? Its current value stops working at once; the new one shows once.`;
                if (await confirm({ action: "Rotate", question })) rotate.mutate(token.id);
              }}
              type="button"
            >
              Rotate
            </button>
            <button
              className="btn danger small"
              disabled={revoke.isPending}
              onClick={async () => {
                const question = `Revoke ${token.name}? Whatever uses it loses access at once.`;
                if (await confirm({ action: "Revoke", question })) revoke.mutate(token.id);
              }}
              type="button"
            >
              Revoke
            </button>
          </div>
        </div>
      ))}
      <form
        className="grid gap-3 rounded-[var(--radius-m)] bg-surface-2 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== "" && !create.isPending) create.mutate();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="form-label min-w-0 flex-1">
            Token name
            <input
              autoComplete="off"
              className="field"
              onChange={(event) => setName(event.target.value)}
              placeholder="github-actions"
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
        </div>
        <ScopeFields onChange={setScope} roles={TOKEN_ROLES} value={scope} />
        <span className="t-faint">
          A token never does more than its account's grants allow, and its scope is fixed once
          minted.
        </span>
        <button
          className="btn justify-self-start"
          disabled={name.trim() === "" || create.isPending}
          type="submit"
        >
          {create.isPending ? "Creating…" : "Create token"}
        </button>
      </form>
      {error ? <ActionError error={error} /> : null}
    </div>
  );
}

/** The account's own events in the audit: what it did, where, with which token, and the result. */
function AccountAudit({ account }: { readonly account: ServiceAccount }) {
  const { api, authRevision } = useDashboardClient();
  const now = useNow();
  const events = useQuery({
    queryFn: () => api.listAudit({ actor: account.id, limit: 20 }),
    queryKey: ["audit", account.id, account.tokens.length, authRevision],
    refetchInterval: 15_000,
  });
  const tokenName = (tokenId: string) =>
    account.tokens.find((token) => token.id === tokenId)?.name ?? "a deleted token";
  return (
    <div className="grid gap-2 px-[18px] py-3.5" data-testid="service-account-audit">
      <b>What it did</b>
      {events.isError ? (
        <ErrorNote error={events.error} title="The audit could not be loaded." />
      ) : events.data === undefined ? (
        <Skeleton label="Loading the audit" lines={2} />
      ) : events.data.events.length === 0 ? (
        <span className="t-meta">Nothing yet. Every change it makes shows here.</span>
      ) : (
        <div className="rows">
          {events.data.events.map((event) => (
            <div className="setting px-0 py-1.5" data-testid="audit-event" key={event.id}>
              <div className="min-w-0">
                <span>{auditActionInWords(event)}</span>
                {event.target.automationSlug === null ? null : (
                  <span className="mono"> {event.target.automationSlug}</span>
                )}
                {event.target.environment === null ? null : (
                  <span className="t-faint"> in {event.target.environment}</span>
                )}
                <div className="t-faint">
                  {event.actor.kind === "service-account"
                    ? `with token ${tokenName(event.actor.tokenId)}`
                    : null}
                </div>
              </div>
              <span className="t-faint">{ageInWords(event.occurredAt, now)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
