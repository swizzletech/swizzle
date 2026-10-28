// Credentials `/credentials`: what deployed automations need and do not have, the stored secrets
// and the connected accounts. Values stay write-only: the page can set, rotate and delete a
// secret but never shows one. A link the agent prints can prefill the secret or connect form.
// `?project=` puts one project in view: the lists show only its credentials and a new secret or
// account joins it unless the form picks another. Each row opens who may use and manage it.

import { AUTOMATION_CONNECTION_NAME_PATTERN } from "@swizzle/config/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ActionError, SecretField } from "../components/actions";
import { useConfirm } from "../components/confirm";
import { CredentialAccess } from "../components/credential-access";
import { NeedsYou } from "../components/needs-you";
import { SecretInput } from "../components/secret-input";
import { Chip, CopyButton, ErrorNote, SectionHead, Skeleton, useNow } from "../components/ui";
import type {
  AutomationSummary,
  ConnectionMetadata,
  CredentialRef,
  ListedConnection,
  Project,
  SecretMetadata,
} from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { refreshAll, useAutomations, useOverview, useProjects } from "../lib/queries";
import type { CredentialsSearch } from "../lib/search";
import { namesInWords } from "../lib/words/credentials";
import type { Tone } from "../lib/words/health";
import { ageInWords } from "../lib/words/time";

export function CredentialsPage() {
  const search = useSearch({ from: "/credentials" });
  const navigate = useNavigate({ from: "/credentials" });
  const overview = useOverview();
  const projects = useProjects();
  const inView = projects.data?.find(
    (project) => project.id === search.project || project.slug === search.project,
  );
  const missing = (overview.data?.needsYou ?? []).filter(
    (item) =>
      (item.kind === "missing-secret" || item.kind === "missing-connection") &&
      (inView === undefined || item.project.id === inView.id),
  );
  const automationsQuery = useAutomations();
  const usage: Usage = automationsQuery.isError ? "unknown" : (automationsQuery.data ?? "loading");
  const view: ProjectView = { inView: inView ?? null, projects: projects.data ?? [] };
  // A link on this page (Missing › Connect) changes only the search; the key remounts the form
  // section so it opens with the link's values.
  const connectLink = [search.connect, search.name, search.scopes, inView?.id].join("|");
  return (
    <>
      <div className="dhead">
        <div className="min-w-0">
          <h1 className="t-page">Credentials</h1>
          <p className="t-meta mt-1.5">
            Secrets and accounts your automations use. Values are stored encrypted and never shown
            again.
          </p>
        </div>
        {projects.data !== undefined && projects.data.length > 1 ? (
          <label className="form-label">
            Project
            <select
              className="field"
              onChange={(event) =>
                void navigate({
                  search: (previous) => ({
                    ...previous,
                    project: event.target.value === "" ? undefined : event.target.value,
                  }),
                })
              }
              value={inView?.slug ?? ""}
            >
              <option value="">All projects</option>
              {projects.data.map((project) => (
                <option key={project.id} value={project.slug}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {projects.isError ? (
        <div className="mt-4">
          <ErrorNote error={projects.error} title="The projects could not be loaded." />
        </div>
      ) : null}
      {overview.isError ? (
        <div className="mt-4">
          <ErrorNote
            error={overview.error}
            onRetry={() => void overview.refetch()}
            title="What deployed automations miss could not be loaded."
          />
        </div>
      ) : null}
      {missing.length > 0 ? (
        <>
          <SectionHead title="Missing">
            <span className="t-faint">
              declared by deployed automations, lost by their deployment
            </span>
          </SectionHead>
          <NeedsYou items={missing} />
        </>
      ) : null}
      <Secrets
        key={`${search.secret ?? ""}|${inView?.id ?? ""}`}
        prefill={search.secret}
        usage={usage}
        view={view}
      />
      <Accounts key={connectLink} search={search} usage={usage} view={view} />
    </>
  );
}

/** The project the page shows, null for all, and every project the person sees. */
interface ProjectView {
  readonly inView: Project | null;
  readonly projects: readonly Project[];
}

/**
 * The projects a new credential may join: those the person edits, the project in view first so
 * the form starts there. A protected environment may still refuse, and the API says why.
 */
function creatableIn(view: ProjectView): readonly Project[] {
  const editable = view.projects.filter(
    (project) => project.role === "editor" || project.role === "admin",
  );
  return editable.toSorted(
    (left, right) => Number(right.id === view.inView?.id) - Number(left.id === view.inView?.id),
  );
}

/** Which project a new credential joins, among those the person may create one in. */
function ProjectPicker(props: {
  readonly label: string;
  readonly onChange: (projectId: string) => void;
  readonly options: readonly Project[];
  readonly value: string;
}) {
  if (props.options.length === 0) {
    return <span className="t-faint">You edit no project, so you cannot add one here.</span>;
  }
  return (
    <select
      aria-label={props.label}
      className="field w-auto"
      onChange={(event) => props.onChange(event.target.value)}
      value={props.value}
    >
      {props.options.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}

/** "Access" and the panel it opens: who may use and manage the credential. */
function useAccessToggle() {
  const [open, setOpen] = useState<string | null>(null);
  const keyOf = (credential: CredentialRef) =>
    `${credential.kind}:${credential.projectId}:${credential.name}`;
  return {
    button: (credential: CredentialRef) => (
      <button
        aria-expanded={open === keyOf(credential)}
        className="btn quiet small"
        onClick={() => setOpen(open === keyOf(credential) ? null : keyOf(credential))}
        type="button"
      >
        Access
      </button>
    ),
    panel: (credential: CredentialRef) =>
      open === keyOf(credential) ? (
        <div className="bg-surface-2 px-[18px] py-3.5">
          <CredentialAccess credential={credential} />
        </div>
      ) : null,
  };
}

/** The deployed automations, or why they are not known yet. */
type Usage = readonly AutomationSummary[] | "loading" | "unknown";

function usedBy(usage: Usage, uses: (automation: AutomationSummary) => boolean): string {
  if (usage === "loading") return "used by …";
  // Claiming "no automation" here could invite deleting a credential a deployed run needs.
  if (usage === "unknown") return "use unknown";
  const names = usage.filter(uses).map((automation) => automation.automationName);
  return names.length === 0 ? "used by no automation" : `used by ${namesInWords(names)}`;
}

function Secrets(props: {
  readonly prefill: string | undefined;
  readonly usage: Usage;
  readonly view: ProjectView;
}) {
  const { view } = props;
  const { api, queryScope } = useDashboardClient();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const now = useNow();
  const secrets = useQuery({
    queryFn: async () => (await api.listSecrets()).secrets,
    queryKey: ["secrets", ...queryScope],
  });
  const shown = (secrets.data ?? []).filter(
    (secret) => view.inView === null || secret.projectId === view.inView.id,
  );
  // Two projects can hold a secret of the same name, so each row names its project.
  const projectOf = (secret: SecretMetadata) => secret.project.name;
  const keyOf = (secret: SecretMetadata) => `${secret.projectId}:${secret.name}`;
  const refOf = (secret: SecretMetadata): CredentialRef => ({
    kind: "secret",
    name: secret.name,
    projectId: secret.projectId,
  });
  const [rotating, setRotating] = useState<string | null>(null);
  const access = useAccessToggle();
  const remove = useMutation({
    mutationFn: (secret: SecretMetadata) => api.deleteSecret(secret.name, secret.projectId),
    onSuccess: () => refreshAll(queryClient),
  });
  return (
    <>
      <SectionHead title="Secrets" />
      <div className="card rows overflow-hidden" data-testid="secrets">
        {secrets.isError ? (
          <div className="p-4">
            <ErrorNote error={secrets.error} title="The secrets could not be loaded." />
          </div>
        ) : secrets.data === undefined ? (
          <Skeleton label="Loading secrets" lines={3} />
        ) : (
          shown.map((secret) => (
            <div key={keyOf(secret)}>
              <div className="setting" data-testid="secret">
                <div className="min-w-0">
                  <span className="mono font-semibold">{secret.name}</span>
                  <div className="t-faint">
                    {projectOf(secret)} · Updated {ageInWords(secret.updatedAt, now)} ·{" "}
                    {usedBy(
                      props.usage,
                      (automation) =>
                        automation.projectId === secret.projectId &&
                        automation.requiredSecrets.some(
                          (required) => required.name === secret.name,
                        ),
                    )}
                    {secret.right === null ? null : ` · you ${secret.right} it`}
                  </div>
                  {rotating === keyOf(secret) ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <SecretField
                        name={secret.name}
                        onSaved={() => setRotating(null)}
                        overwrite
                        projectId={secret.projectId}
                      />
                      <button
                        className="btn quiet small"
                        onClick={() => setRotating(null)}
                        type="button"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {secret.right === null ? null : access.button(refOf(secret))}
                  {secret.right === "manage" ? (
                    <>
                      <button
                        className="btn quiet small"
                        onClick={() => setRotating(keyOf(secret))}
                        type="button"
                      >
                        Rotate
                      </button>
                      <button
                        className="btn danger small"
                        disabled={remove.isPending}
                        onClick={async () => {
                          const question = `Delete ${secret.name} from ${projectOf(secret)}? Runs that need it stop starting until it is set again and its automations are deployed again.`;
                          if (await confirm({ action: "Delete", question })) remove.mutate(secret);
                        }}
                        type="button"
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              {access.panel(refOf(secret))}
            </div>
          ))
        )}
        {remove.isError ? (
          <div className="px-[18px] py-2">
            <ActionError error={remove.error} />
          </div>
        ) : null}
        <AddSecret prefill={props.prefill} view={view} />
      </div>
    </>
  );
}

function AddSecret(props: { readonly prefill: string | undefined; readonly view: ProjectView }) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState(props.prefill ?? "");
  const [value, setValue] = useState("");
  const options = creatableIn(props.view);
  const [chosen, setChosen] = useState<string | null>(null);
  // Until the person picks one, the form follows the project in view as the projects load.
  const projectId = chosen ?? options[0]?.id;
  const valueField = useRef<HTMLInputElement>(null);
  // A link that names the secret leaves only the value to type.
  useEffect(() => {
    if (props.prefill !== undefined) valueField.current?.focus();
  }, [props.prefill]);
  const add = useMutation({
    mutationFn: () =>
      api.upsertSecret(name.trim(), value, projectId === undefined ? {} : { project: projectId }),
    onSuccess: async () => {
      setName("");
      setValue("");
      await refreshAll(queryClient);
    },
  });
  const ready = name.trim() !== "" && value !== "" && projectId !== undefined && !add.isPending;
  return (
    <form
      className="setting bg-surface-2"
      data-testid="add-secret"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) add.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Secret name"
          className="field w-56"
          onChange={(event) => setName(event.target.value.toUpperCase())}
          placeholder="NAME"
          value={name}
        />
        <SecretInput
          aria-label="Secret value"
          className="min-w-0 flex-1"
          onValueChange={setValue}
          placeholder="Value"
          ref={valueField}
          value={value}
        />
        <ProjectPicker
          label="Project of the new secret"
          onChange={setChosen}
          options={options}
          value={projectId ?? ""}
        />
        {add.isError ? <ActionError error={add.error} /> : null}
      </div>
      <button className="btn" disabled={!ready} type="submit">
        {add.isPending ? "Adding…" : "Add secret"}
      </button>
    </form>
  );
}

const PROVIDERS = [
  { label: "Google Workspace", value: "google" },
  { label: "Microsoft", value: "microsoft" },
  { label: "GitHub", value: "github" },
  { label: "ClickUp", value: "clickup" },
  { label: "Generic OAuth2", value: "custom-oauth2" },
] as const;

function providerLabel(value: string): string {
  return PROVIDERS.find((provider) => provider.value === value)?.label ?? value;
}

const CONNECTION_STATE: Record<
  ConnectionMetadata["status"],
  { readonly label: string; readonly tone: Tone }
> = {
  active: { label: "Connected", tone: "ok" },
  error: { label: "Not working", tone: "fail" },
  pending: { label: "Waiting for sign-in", tone: "warn" },
  revoked: { label: "Revoked", tone: "idle" },
};

/** "Verified 3 min ago", "Not verified" or "Last error 2 h ago". */
function connectionCheckInWords(connection: ConnectionMetadata, now: Date): string {
  if (connection.status === "active") {
    return `Verified ${ageInWords(connection.lastRefreshedAt ?? connection.createdAt, now)}`;
  }
  if (connection.lastErrorCode === null) return "Not verified";
  if (connection.lastErrorAt === null) return "Last error";
  return `Last error ${ageInWords(connection.lastErrorAt, now)}`;
}

/**
 * Opens a blank window for the provider's sign-in, or null when the browser blocked it. Call it
 * inside the click: a popup blocker refuses a window opened after the API answers. Each sign-in
 * keeps its own window, so two that overlap never swap pages.
 */
function openSignInWindow(): Window | null {
  return window.open("about:blank", "_blank");
}

/** The sign-in the page last started: its consent page, and whether the browser blocked its window. */
interface Consent {
  readonly blocked: boolean;
  readonly url: string;
}

/** Sends a sign-in's own window to the provider's consent page; the page keeps the link too. */
function showConsent(signInWindow: Window | null, authorizationUrl: string): Consent {
  if (signInWindow !== null && !signInWindow.closed) {
    // The provider's page must not reach back into the dashboard.
    signInWindow.opener = null;
    signInWindow.location.replace(authorizationUrl);
  }
  return { blocked: signInWindow === null, url: authorizationUrl };
}

/** True while the owner's sign-in at the provider has not come back yet. */
function signingIn(connection: ConnectionMetadata): boolean {
  return connection.status === "pending" || connection.authorizationPending;
}

function Accounts(props: {
  readonly search: CredentialsSearch;
  readonly usage: Usage;
  readonly view: ProjectView;
}) {
  const { view } = props;
  const { api, queryScope } = useDashboardClient();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const now = useNow();
  const prefilled = props.search.connect !== undefined || props.search.name !== undefined;
  const [connecting, setConnecting] = useState(prefilled);
  const connections = useQuery({
    queryFn: () => api.listConnections(),
    queryKey: ["connections", ...queryScope],
    // While a sign-in at the provider is open, watch for it to finish.
    refetchInterval: (query) => (query.state.data?.connections.some(signingIn) ? 3_000 : false),
  });
  const [consent, setConsent] = useState<Consent | null>(null);
  const test = useMutation({
    mutationFn: (connection: ConnectionMetadata) =>
      api.testConnection(connection.name, connection.project.id),
    onSuccess: () => refreshAll(queryClient),
  });
  const reconnect = useMutation({
    mutationFn: ({ connection }: { connection: ConnectionMetadata; signInWindow: Window | null }) =>
      api.authorizeConnection(
        connection.name,
        connection.scopes.length > 0 ? { scopes: connection.scopes } : {},
        connection.project.id,
      ),
    onError: (_error, { signInWindow }) => signInWindow?.close(),
    onSuccess: async (result, { signInWindow }) => {
      setConsent(showConsent(signInWindow, result.authorizationUrl));
      await refreshAll(queryClient);
    },
  });
  const remove = useMutation({
    mutationFn: (connection: ConnectionMetadata) =>
      api.deleteConnection(connection.name, connection.project.id),
    onSuccess: () => refreshAll(queryClient),
  });
  const access = useAccessToggle();
  const all = connections.data?.connections ?? [];
  const list = all.filter(
    (connection) => view.inView === null || connection.project.id === view.inView.id,
  );
  const actionError = test.error ?? reconnect.error ?? remove.error;
  const signInOpen = all.some(signingIn);

  return (
    <>
      <SectionHead title="Accounts">
        {connecting ? null : (
          <button className="btn small ml-auto" onClick={() => setConnecting(true)} type="button">
            Connect an account
          </button>
        )}
      </SectionHead>
      {connecting ? (
        <ConnectForm
          connections={all}
          onClose={() => setConnecting(false)}
          onConsent={setConsent}
          redirectBaseUrl={connections.data?.redirectBaseUrl ?? null}
          search={props.search}
          view={view}
        />
      ) : null}
      {consent !== null && signInOpen ? (
        <p className="notice mb-3">
          {consent.blocked
            ? "Your browser blocked the sign-in window."
            : "Finish the sign-in in the window that opened. Nothing opened?"}{" "}
          <a className="linkish" href={consent.url} rel="noopener noreferrer" target="_blank">
            Open the sign-in page
          </a>
          {consent.blocked ? " to finish connecting." : "."}
        </p>
      ) : null}
      <div className="card rows overflow-hidden" data-testid="accounts">
        {connections.isError ? (
          <div className="p-4">
            <ErrorNote error={connections.error} title="The accounts could not be loaded." />
          </div>
        ) : connections.data === undefined ? (
          <Skeleton label="Loading accounts" lines={2} />
        ) : list.length === 0 ? (
          <p className="t-meta px-[18px] py-3.5">
            No account is connected
            {view.inView === null ? "" : ` to ${view.inView.name}`} in this environment.
          </p>
        ) : (
          list.map((connection) => {
            const state = CONNECTION_STATE[connection.status];
            const ref: CredentialRef = {
              kind: "connection",
              name: connection.name,
              projectId: connection.project.id,
            };
            return (
              <div key={connection.id}>
                <div className="setting" data-testid="account">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <b>{connection.name}</b>
                      <span className="t-meta">{providerLabel(connection.provider)}</span>
                      <Chip tone={state.tone}>{state.label}</Chip>
                    </div>
                    <div className="t-faint mt-0.5">
                      {connection.project.name} · {connectionCheckInWords(connection, now)} ·{" "}
                      {usedBy(
                        props.usage,
                        (automation) =>
                          automation.projectId === connection.project.id &&
                          automation.requiredConnections.some(
                            (required) => required.name === connection.name,
                          ),
                      )}
                      {connection.right === null ? null : ` · you ${connection.right} it`}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {connection.right === null ? null : access.button(ref)}
                    {connection.right !== null && connection.status === "active" ? (
                      <button
                        className="btn quiet small"
                        disabled={test.isPending}
                        onClick={() => test.mutate(connection)}
                        type="button"
                      >
                        Test
                      </button>
                    ) : null}
                    {connection.right === "manage" && connection.status !== "active" ? (
                      <button
                        className="btn small"
                        disabled={reconnect.isPending}
                        onClick={() =>
                          reconnect.mutate({ connection, signInWindow: openSignInWindow() })
                        }
                        type="button"
                      >
                        Reconnect
                      </button>
                    ) : null}
                    {connection.right === "manage" ? (
                      <button
                        className="btn danger small"
                        disabled={remove.isPending}
                        onClick={async () => {
                          const question = `Delete ${connection.name}? This revokes its tokens.`;
                          if (await confirm({ action: "Delete", question })) {
                            remove.mutate(connection);
                          }
                        }}
                        type="button"
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>
                {access.panel(ref)}
              </div>
            );
          })
        )}
        {actionError ? (
          <div className="px-[18px] py-2">
            <ActionError error={actionError} />
          </div>
        ) : null}
      </div>
    </>
  );
}

const NEW_CREDENTIALS = "";

/** The provider settings beyond client id and secret: endpoints for generic OAuth2, a tenant for Microsoft. */
function providerConfigFor(
  provider: string,
  fields: { readonly authorizeUrl: string; readonly tenant: string; readonly tokenUrl: string },
) {
  if (provider === "custom-oauth2") {
    return {
      providerConfig: {
        authorizeUrl: fields.authorizeUrl.trim(),
        tokenUrl: fields.tokenUrl.trim(),
      },
    };
  }
  if (provider === "microsoft" && fields.tenant.trim() !== "") {
    return { providerConfig: { tenant: fields.tenant.trim() } };
  }
  return {};
}

function ConnectForm(props: {
  readonly connections: readonly ListedConnection[];
  readonly onClose: () => void;
  readonly onConsent: (consent: Consent) => void;
  readonly redirectBaseUrl: string | null;
  readonly search: CredentialsSearch;
  readonly view: ProjectView;
}) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState(props.search.connect ?? "google");
  const [name, setName] = useState(props.search.name ?? "");
  const [scopes, setScopes] = useState(props.search.scopes?.split(",").join("\n") ?? "");
  const [reuseFrom, setReuseFrom] = useState(NEW_CREDENTIALS);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenant, setTenant] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const projects = creatableIn(props.view);
  const [chosenProject, setChosenProject] = useState<string | null>(null);
  const projectId = chosenProject ?? projects[0]?.id;

  // An account of the same provider that the person manages can lend its client id and secret to
  // a new one, which then joins the lender's project.
  const reusable = props.connections.filter(
    (connection) => connection.provider === provider && connection.right === "manage",
  );
  const source = reusable.find((connection) => connection.id === reuseFrom);
  const nameValid = AUTOMATION_CONNECTION_NAME_PATTERN.test(name.trim());

  const connect = useMutation({
    mutationFn: (_signInWindow: Window | null) => {
      const scopeList = scopes
        .split(/[\n,]/u)
        .map((scope) => scope.trim())
        .filter((scope) => scope !== "");
      const scopeInput = scopeList.length > 0 ? { scopes: scopeList } : {};
      if (source !== undefined) {
        return api.authorizeConnection(
          name.trim(),
          { reuseFrom: source.name, ...scopeInput },
          source.project.id,
        );
      }
      if (provider === "custom-oauth2" && (authorizeUrl.trim() === "" || tokenUrl.trim() === "")) {
        throw new Error("Generic OAuth2 needs an authorize URL and a token URL.");
      }
      return api.authorizeConnection(
        name.trim(),
        {
          clientId: clientId.trim(),
          clientSecret,
          provider,
          ...providerConfigFor(provider, { authorizeUrl, tenant, tokenUrl }),
          ...scopeInput,
        },
        projectId,
      );
    },
    onError: (_error, signInWindow) => signInWindow?.close(),
    onSuccess: async (result, signInWindow) => {
      props.onConsent(showConsent(signInWindow, result.authorizationUrl));
      props.onClose();
      await refreshAll(queryClient);
    },
  });
  const ready =
    nameValid &&
    (source !== undefined ||
      (clientId.trim() !== "" && clientSecret !== "" && projectId !== undefined));
  const redirectPath = `/oauth/callback/${provider}`;

  return (
    <form
      className="card mb-3.5 grid gap-3 px-5 py-4"
      data-testid="connect-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !connect.isPending) connect.mutate(openSignInWindow());
      }}
    >
      <h3 className="t-section">Connect an account</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="form-label">
          Service
          <select
            className="field"
            onChange={(event) => setProvider(event.target.value)}
            value={provider}
          >
            {PROVIDERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="form-label">
          Name
          <input
            className="field"
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. google-jan"
            value={name}
          />
          {name.trim() !== "" && !nameValid ? (
            <span className="text-[12px] font-normal text-fail">
              Lowercase letters, digits and hyphens, up to 60 characters, e.g. google-jan.
            </span>
          ) : null}
        </label>
      </div>
      {reusable.length > 0 ? (
        <label className="form-label">
          Client credentials
          <select
            className="field"
            onChange={(event) => setReuseFrom(event.target.value)}
            value={reuseFrom}
          >
            <option value={NEW_CREDENTIALS}>Enter a new client ID and secret</option>
            {reusable.map((connection) => (
              <option key={connection.id} value={connection.id}>
                Reuse those of {connection.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {source === undefined ? (
        <div className="form-label">
          Project
          <ProjectPicker
            label="Project of the new account"
            onChange={setChosenProject}
            options={projects}
            value={projectId ?? ""}
          />
        </div>
      ) : (
        <p className="t-meta m-0">
          It joins {source.project.name}, where {source.name} is.
        </p>
      )}
      {source !== undefined ? null : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="form-label">
            Client ID
            <input
              className="field"
              onChange={(event) => setClientId(event.target.value)}
              value={clientId}
            />
          </label>
          <label className="form-label">
            Client secret
            <SecretInput onValueChange={setClientSecret} value={clientSecret} />
          </label>
          {provider === "custom-oauth2" ? (
            <>
              <label className="form-label">
                Authorize URL
                <input
                  className="field"
                  onChange={(event) => setAuthorizeUrl(event.target.value)}
                  placeholder="https://auth.example.com/oauth/authorize"
                  value={authorizeUrl}
                />
              </label>
              <label className="form-label">
                Token URL
                <input
                  className="field"
                  onChange={(event) => setTokenUrl(event.target.value)}
                  placeholder="https://auth.example.com/oauth/token"
                  value={tokenUrl}
                />
              </label>
            </>
          ) : null}
          {provider === "microsoft" ? (
            <label className="form-label">
              Tenant (optional)
              <input
                className="field"
                onChange={(event) => setTenant(event.target.value)}
                placeholder="common"
                value={tenant}
              />
            </label>
          ) : null}
        </div>
      )}
      <label className="form-label">
        Scopes (optional, one per line)
        <textarea
          className="field"
          onChange={(event) => setScopes(event.target.value)}
          rows={2}
          value={scopes}
        />
      </label>
      {source !== undefined ? null : props.redirectBaseUrl === null ? (
        <p className="t-faint">
          Register the redirect URI <span className="mono">{redirectPath}</span> on this API's
          public address in the provider's console. Set{" "}
          <span className="mono">SWIZZLE_PUBLIC_URL</span> on the API to see the full URL here.
        </p>
      ) : (
        <p className="t-faint flex flex-wrap items-center gap-2">
          Register this redirect URI in the provider's console first:{" "}
          <span className="mono">{`${props.redirectBaseUrl}${redirectPath}`}</span>
          <CopyButton
            className="btn quiet small"
            label="Copy"
            text={`${props.redirectBaseUrl}${redirectPath}`}
          />
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" disabled={!ready || connect.isPending} type="submit">
          {connect.isPending ? "Opening sign-in…" : "Continue to sign-in"}
        </button>
        <button className="btn quiet" onClick={props.onClose} type="button">
          Cancel
        </button>
        {connect.isError ? <ActionError error={connect.error} /> : null}
      </div>
    </form>
  );
}
