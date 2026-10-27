// Who may use and manage one secret or connection: every person, team and service account with a
// right on it and where that right comes from (a grant to them, to a team of theirs, or their
// role), and the projects it is shared with. Someone who manages it adds and removes grants here;
// anyone else with a right sees the same list read-only. The Credentials page opens it per row.
//
// The holders and their rights come from the API's policy (GET /credentials/:kind/:name/access);
// this panel shows them and never derives what a grant allows.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import type {
  CredentialAccessView,
  CredentialHolder,
  CredentialRef,
  CredentialRight,
  Subject,
} from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { refreshAll, useDirectory, useProjects } from "../lib/queries";
import {
  CREDENTIAL_RIGHT_IN_WORDS,
  credentialShareInWords,
  credentialSourceInWords,
} from "../lib/words/credentials";
import { ActionError } from "./actions";
import { HolderRow } from "./holder-row";
import { subjectKey, subjectOptions, subjectRef } from "./share-form";
import { Chip, ErrorNote, Skeleton, useNow } from "./ui";

const RIGHTS: readonly CredentialRight[] = ["use", "manage"];

export function CredentialAccess(props: { readonly credential: CredentialRef }) {
  const { credential } = props;
  const { api, queryScope } = useDashboardClient();
  const access = useQuery({
    queryFn: () => api.getCredentialAccess(credential),
    queryKey: [
      "credential-access",
      credential.kind,
      credential.projectId,
      credential.name,
      ...queryScope,
    ],
  });
  if (access.isError) {
    return <ErrorNote error={access.error} title="Who may use it could not be loaded." />;
  }
  if (access.data === undefined) return <Skeleton label="Loading who may use it" lines={3} />;
  return <LoadedAccess access={access.data} credential={credential} />;
}

function LoadedAccess(props: {
  readonly access: CredentialAccessView;
  readonly credential: CredentialRef;
}) {
  const { access, credential } = props;
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const now = useNow();
  const manages = access.right === "manage";
  const owner = useProjects().data?.find((project) => project.id === credential.projectId);
  const remove = useMutation({
    mutationFn: (subject: Subject) => api.removeCredentialGrant(credential, subjectRef(subject)),
    onSettled: () => refreshAll(queryClient),
  });
  return (
    <div className="grid gap-3" data-testid="credential-access">
      <p className="t-meta m-0">
        {manages
          ? "You manage it. The highest right that applies counts; removing one grant leaves the others."
          : "You may use it. Only someone who manages it changes who holds what."}
      </p>
      <div className="card rows overflow-hidden">
        {access.holders.map((holder) => (
          <CredentialHolderRow
            holder={holder}
            key={subjectKey(holder.subject)}
            onRemove={manages ? () => remove.mutate(holder.subject) : null}
            removing={remove.isPending}
          />
        ))}
        {access.shares.map((share) => (
          <div className="setting" data-testid="credential-share" key={share.shareId}>
            <div className="min-w-0">
              <b>{share.project.name}</b> <Chip tone="idle">Project</Chip>
              <div className="t-meta mt-0.5">{credentialShareInWords(share, now)}</div>
            </div>
          </div>
        ))}
        {remove.isError ? (
          <div className="px-[18px] py-2">
            <ActionError error={remove.error} />
          </div>
        ) : null}
      </div>
      {owner === undefined ? null : (
        <p className="t-faint m-0">
          Other projects get it by a share:{" "}
          <Link
            className="linkish"
            params={{ project: owner.slug }}
            search={{ tab: "credentials" }}
            to="/projects/$project"
          >
            offer or take it back on {owner.name}'s Credentials tab
          </Link>
          .
        </p>
      )}
      {manages ? <GrantForm access={access} credential={credential} /> : null}
    </div>
  );
}

/** One holder: their right, every source of it, and Remove for a grant that names them. */
function CredentialHolderRow(props: {
  readonly holder: CredentialHolder;
  /** Null when the viewer may not change grants. */
  readonly onRemove: (() => void) | null;
  readonly removing: boolean;
}) {
  const { holder } = props;
  const granted = holder.sources.some((source) => source.kind === "grant");
  return (
    <HolderRow
      action={
        granted && props.onRemove !== null ? (
          <button
            aria-label={`Remove the grant of ${holder.name}`}
            className="btn quiet small"
            disabled={props.removing}
            onClick={props.onRemove}
            type="button"
          >
            Remove grant
          </button>
        ) : null
      }
      chips={
        <>
          {" "}
          <Chip tone={holder.right === "manage" ? "ok" : "run"}>{holder.right}</Chip>
        </>
      }
      holder={holder}
      testId="credential-holder"
    >
      {holder.sources.map((source) => (
        <span className="t-meta" key={JSON.stringify(source)}>
          {credentialSourceInWords(source, holder.right)}
        </span>
      ))}
    </HolderRow>
  );
}

/** Gives a person, team or service account use or manage, replacing a right they hold by grant. */
function GrantForm(props: {
  readonly access: CredentialAccessView;
  readonly credential: CredentialRef;
}) {
  const { access, credential } = props;
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const directory = useDirectory();
  const [chosen, setChosen] = useState("");
  const [right, setRight] = useState<CredentialRight>("use");
  const options = subjectOptions(directory.data, access.serviceAccounts);
  const subject = options.find((option) => option.key === chosen)?.subject;
  const grant = useMutation({
    mutationFn: async () => {
      if (subject === undefined) return;
      await api.setCredentialGrant(credential, subjectRef(subject), right);
    },
    onSuccess: async () => {
      setChosen("");
      await refreshAll(queryClient);
    },
  });
  const ready = subject !== undefined && !grant.isPending;
  return (
    <form
      aria-label={`Grant a right on ${credential.name}`}
      className="card grid gap-3 px-5 py-4"
      data-testid="credential-grant-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) grant.mutate();
      }}
    >
      <h3 className="t-section">Grant a right</h3>
      {directory.isError ? <ActionError error={directory.error} /> : null}
      <label className="form-label">
        Who
        <select
          className="field"
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
      <fieldset className="grid gap-2 border-0 p-0">
        <legend className="form-label mb-1.5">Right</legend>
        {RIGHTS.map((option) => (
          <label className="flex items-start gap-2" key={option}>
            <input
              checked={right === option}
              className="mt-1"
              name="right"
              onChange={() => setRight(option)}
              type="radio"
            />
            <span>
              <b className="capitalize">{option}</b>
              <span className="t-faint block">{CREDENTIAL_RIGHT_IN_WORDS[option]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {grant.isError ? <ActionError error={grant.error} /> : null}
      <div>
        <button className="btn" disabled={!ready} type="submit">
          {grant.isPending ? "Granting…" : "Grant"}
        </button>
      </div>
    </form>
  );
}
