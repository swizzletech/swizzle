// The one form that gives a person, team or service account a role in a project: on the whole
// project, on one automation, or in one protected environment. It shows what the chosen holder already has
// and where it comes from, and what the role means for the project's credentials. The project's
// Access, Environments and Service accounts tabs all open it.

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
  AccessGrant,
  DirectoryResponse,
  GrantPlaceRef,
  ProjectAccess,
  ProjectRole,
  Subject,
  SubjectRef,
} from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { useAutomations, useDirectory } from "../lib/queries";
import { grantInWords, ROLE_IN_WORDS } from "../lib/words/access";
import { credentialConsequence } from "../lib/words/credentials";
import { ActionError } from "./actions";

const ROLES: readonly ProjectRole[] = ["viewer", "operator", "editor", "admin"];

export interface ShareFormProps {
  readonly access: ProjectAccess;
  /** Fixed by the caller: Environments shares its row's environment. */
  readonly place?: GrantPlaceRef;
  /** Preselected, when the form opens from a holder's row. */
  readonly subject?: Subject;
  readonly onDone: () => void;
}

export function subjectKey(subject: Subject): string {
  if (subject.kind === "user") return `user:${subject.userId}`;
  if (subject.kind === "team") return `team:${subject.teamId}`;
  return `service-account:${subject.serviceAccountId}`;
}

/** A holder a grant form offers: its option value, its words, and the subject the grant names. */
export interface SubjectOption {
  readonly key: string;
  readonly label: string;
  readonly subject: Subject;
}

/** The directory's people, then its teams, then the given service accounts, as grant forms list them. */
export function subjectOptions(
  directory: DirectoryResponse | undefined,
  serviceAccounts: readonly { readonly id: string; readonly name: string }[],
): SubjectOption[] {
  const option = (subject: Subject, label: string) => ({
    key: subjectKey(subject),
    label,
    subject,
  });
  return [
    ...(directory?.users ?? []).map((person) =>
      option({ kind: "user", userId: person.id }, `${person.name} (${person.email})`),
    ),
    ...(directory?.teams ?? []).map((team) =>
      option({ kind: "team", teamId: team.id }, `Team ${team.name}`),
    ),
    ...serviceAccounts.map((account) =>
      option(
        { kind: "service-account", serviceAccountId: account.id },
        `Service account ${account.name}`,
      ),
    ),
  ];
}

/** The body fields that name `subject` to the grant routes. */
export function subjectRef(subject: Subject): SubjectRef {
  if (subject.kind === "user") return { user: subject.userId };
  if (subject.kind === "team") return { team: subject.teamId };
  return { serviceAccount: subject.serviceAccountId };
}

/** Where a stored grant applies, as the grant routes name it. */
export function placeOf(
  grant: AccessGrant,
  slugOf: (automationId: string) => string,
): GrantPlaceRef {
  if (grant.on === "automation")
    return { automation: slugOf(grant.automationId), on: "automation" };
  if (grant.on === "environment") return { environment: grant.environment, on: "environment" };
  return { on: "project" };
}

/** After a grant or team change: who holds what, and the viewer's own role, may both differ. */
export async function accessChanged(queryClient: QueryClient) {
  await Promise.all(
    ["project-access", "service-accounts", "projects", "own-access", "directory"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}

/** The place the form describes, or null while its automation or environment is unchosen. */
function chosenPlace(
  kind: GrantPlaceRef["on"],
  automation: string,
  environment: string,
): GrantPlaceRef | null {
  switch (kind) {
    case "project":
      return { on: "project" };
    case "automation":
      return automation === "" ? null : { automation, on: "automation" };
    case "environment":
      return environment === "" ? null : { environment, on: "environment" };
  }
}

export function ShareForm(props: ShareFormProps) {
  const { access } = props;
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const directory = useDirectory();
  const automations = (useAutomations().data ?? []).filter(
    (automation) => automation.projectId === access.project.id,
  );
  const accounts = access.holders.flatMap(({ name, subject }) =>
    subject.kind === "service-account" ? [{ id: subject.serviceAccountId, name }] : [],
  );

  const [chosen, setChosen] = useState(
    props.subject === undefined ? "" : subjectKey(props.subject),
  );
  const [placeKind, setPlaceKind] = useState<GrantPlaceRef["on"]>(props.place?.on ?? "project");
  const [automation, setAutomation] = useState(
    props.place?.on === "automation" ? props.place.automation : "",
  );
  const [pickedEnvironment, setEnvironment] = useState(
    props.place?.on === "environment" ? props.place.environment : "",
  );
  // Derived on every render: an access refresh may unprotect the picked environment, and only a
  // protected one may be shared.
  const environment = access.protectedEnvironments.includes(pickedEnvironment)
    ? pickedEnvironment
    : (access.protectedEnvironments[0] ?? "");
  const [role, setRole] = useState<ProjectRole>("viewer");

  const options = subjectOptions(directory.data, accounts);
  const subject = options.find((option) => option.key === chosen)?.subject;
  const place = chosenPlace(placeKind, automation, environment);
  const serviceAccount = subject?.kind === "service-account";
  // Admin is a project role only, and never a service account's.
  const allowed = ROLES.filter(
    (option) => option !== "admin" || (placeKind === "project" && !serviceAccount),
  );
  const effectiveRole = allowed.includes(role) ? role : "viewer";

  // What the chosen holder holds already: their own grants, then those through a team.
  const holder =
    subject === undefined
      ? undefined
      : access.holders.find((candidate) => subjectKey(candidate.subject) === subjectKey(subject));
  const held = [
    ...access.grants
      .filter((grant) => subject !== undefined && subjectKey(grant.subject) === subjectKey(subject))
      .map((grant) => ({ grant, teamName: null })),
    ...(holder?.teamGrants ?? []),
  ];
  const automationName = (automationId: string) =>
    automations.find((candidate) => candidate.automationId === automationId)?.automationName ??
    "an automation";

  const share = useMutation({
    mutationFn: async () => {
      if (subject === undefined || place === null) return;
      await api.setGrant(access.project.slug, subjectRef(subject), place, effectiveRole);
    },
    onSuccess: async () => {
      await accessChanged(queryClient);
      props.onDone();
    },
  });
  const ready = subject !== undefined && place !== null && !share.isPending;

  return (
    <form
      aria-label={`Share ${access.project.name}`}
      className="card grid gap-4 px-5 py-4"
      data-testid="share-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) share.mutate();
      }}
    >
      <h3 className="t-section">Share {access.project.name}</h3>
      {directory.isError ? <ActionError error={directory.error} /> : null}
      <label className="form-label">
        Who
        <select
          className="field"
          disabled={props.subject !== undefined}
          onChange={(event) => setChosen(event.target.value)}
          value={chosen}
        >
          <option value="">Choose a person, team or service account</option>
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {subject === undefined ? null : (
        <div className="t-meta" data-testid="share-holds">
          {held.length === 0
            ? "Holds nothing in this project yet."
            : `Holds already: ${held
                .map(({ grant, teamName }) => grantInWords(grant, automationName, teamName))
                .join("; ")}. The highest role that applies counts.`}
        </div>
      )}
      {props.place === undefined ? (
        <fieldset className="grid gap-1.5 border-0 p-0">
          <legend className="form-label mb-1.5">Where</legend>
          <label className="flex items-center gap-2">
            <input
              checked={placeKind === "project"}
              name="place"
              onChange={() => setPlaceKind("project")}
              type="radio"
            />
            The whole project
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input
              checked={placeKind === "automation"}
              name="place"
              onChange={() => setPlaceKind("automation")}
              type="radio"
            />
            One automation
            {placeKind === "automation" ? (
              <select
                aria-label="Automation"
                className="field small"
                onChange={(event) => setAutomation(event.target.value)}
                value={automation}
              >
                <option value="">Choose</option>
                {automations.map((item) => (
                  <option key={item.automationSlug} value={item.automationSlug}>
                    {item.automationName}
                  </option>
                ))}
              </select>
            ) : null}
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input
              checked={placeKind === "environment"}
              // An environment grant exists only where the environment is protected.
              disabled={access.protectedEnvironments.length === 0}
              name="place"
              onChange={() => setPlaceKind("environment")}
              type="radio"
            />
            One protected environment
            {access.protectedEnvironments.length === 0 ? (
              <span className="t-faint">(protect one under Environments first)</span>
            ) : null}
            {placeKind === "environment" ? (
              <select
                aria-label="Environment to share"
                className="field small"
                onChange={(event) => setEnvironment(event.target.value)}
                value={environment}
              >
                {access.protectedEnvironments.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : null}
          </label>
        </fieldset>
      ) : null}
      <fieldset className="grid gap-2 border-0 p-0">
        <legend className="form-label mb-1.5">Role</legend>
        {allowed.map((option) => (
          <label className="flex items-start gap-2" key={option}>
            <input
              checked={effectiveRole === option}
              className="mt-1"
              name="role"
              onChange={() => setRole(option)}
              type="radio"
            />
            <span>
              <b className="capitalize">{option}</b>
              <span className="t-faint block">{ROLE_IN_WORDS[option]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="notice m-0" data-testid="credential-consequence">
        {credentialConsequence(effectiveRole, placeKind)}
      </p>
      {share.isError ? <ActionError error={share.error} /> : null}
      <div className="flex flex-wrap gap-2">
        <button className="btn" disabled={!ready} type="submit">
          {share.isPending ? "Sharing…" : "Share"}
        </button>
        <button className="btn quiet" onClick={props.onDone} type="button">
          Cancel
        </button>
      </div>
    </form>
  );
}
