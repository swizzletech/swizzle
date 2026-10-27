// A project's Credentials tab: the shares other projects offer it, which its admins accept or
// decline, and the credentials it owns that the person manages, each with the projects it is
// offered to and a control to offer it to one more. Accepting lets deployments in this project
// bind the credential; until then they cannot.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { ActionError } from "../components/actions";
import { Chip, ErrorNote, Skeleton, useNow } from "../components/ui";
import type { CredentialRef, CredentialShare, Project } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { refreshAll, useProjects } from "../lib/queries";
import { credentialShareInWords } from "../lib/words/credentials";

export function ProjectCredentials(props: { readonly project: Project }) {
  const { project } = props;
  return (
    <>
      <section className="mt-4">
        <div className="sec-head">
          <h2 className="t-section">Offered to {project.name}</h2>
          <p className="t-meta">
            Accepting lets this project's deployments bind the credential in its environment; until
            then they cannot. Declining or ending a share stops the next injection.
          </p>
        </div>
        {project.role === "admin" ? (
          <Offered project={project} />
        ) : (
          <p className="card t-meta px-5 py-4">
            Only the project's admins accept or decline an offer. Ask one of them.
          </p>
        )}
      </section>
      <section className="mt-4">
        <div className="sec-head">
          <h2 className="t-section">Shared by {project.name}</h2>
          <p className="t-meta">
            Offer a credential you manage to another project; an admin there accepts it. Its code
            can then send the value anywhere, so a share is trust in that project's authors.
          </p>
        </div>
        <Shared project={project} />
      </section>
    </>
  );
}

const KIND_LABEL = { connection: "Account", secret: "Secret" } as const;

function Offered({ project }: { readonly project: Project }) {
  const { api, authRevision } = useDashboardClient();
  const queryClient = useQueryClient();
  const now = useNow();
  const shares = useQuery({
    queryFn: () => api.listCredentialShares(project.slug),
    queryKey: ["credential-shares", project.slug, authRevision],
  });
  const accept = useMutation({
    mutationFn: (share: CredentialShare) => api.acceptCredentialShare(project.slug, share.shareId),
    onSettled: () => refreshAll(queryClient),
  });
  const decline = useMutation({
    mutationFn: (share: CredentialShare) => api.declineCredentialShare(project.slug, share.shareId),
    onSettled: () => refreshAll(queryClient),
  });
  if (shares.isError) {
    return <ErrorNote error={shares.error} title="The offers could not be loaded." />;
  }
  if (shares.data === undefined) {
    return (
      <div className="card">
        <Skeleton label="Loading the offers" lines={2} />
      </div>
    );
  }
  if (shares.data.length === 0) {
    return <p className="card t-meta px-5 py-4">No project offers {project.name} a credential.</p>;
  }
  const failed = accept.error ?? decline.error;
  return (
    <div className="card rows overflow-hidden" data-testid="offered-shares">
      {shares.data.map((share) => (
        <div className="setting" data-testid="offered-share" key={share.shareId}>
          <div className="min-w-0">
            <span className="mono font-semibold">{share.credential.name}</span>{" "}
            <Chip tone="idle">{KIND_LABEL[share.credential.kind]}</Chip>{" "}
            {share.acceptedAt === null ? (
              <Chip tone="warn">Waiting for you</Chip>
            ) : (
              <Chip tone="ok">Accepted</Chip>
            )}
            <div className="t-meta mt-0.5">
              From {share.credentialProject.name}, in {share.credential.environment}
              {share.acceptedAt === null ? "" : ` · ${credentialShareInWords(share, now)}`}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {share.acceptedAt === null ? (
              <button
                className="btn small"
                disabled={accept.isPending}
                onClick={() => accept.mutate(share)}
                type="button"
              >
                Accept
              </button>
            ) : null}
            <button
              className="btn quiet small"
              disabled={decline.isPending}
              onClick={() => decline.mutate(share)}
              type="button"
            >
              {share.acceptedAt === null ? "Decline" : "End share"}
            </button>
          </div>
        </div>
      ))}
      {failed ? (
        <div className="px-[18px] py-2">
          <ActionError error={failed} />
        </div>
      ) : null}
    </div>
  );
}

/** The project's credentials in this environment that the person manages, each with its shares. */
function Shared({ project }: { readonly project: Project }) {
  const { api, environment, queryScope } = useDashboardClient();
  const shared = useQuery({
    queryFn: () => api.listSharedCredentials(project.slug),
    queryKey: ["shared-credentials", project.slug, ...queryScope],
  });
  if (shared.isError) {
    return (
      <ErrorNote error={shared.error} title="The project's credentials could not be loaded." />
    );
  }
  if (shared.data === undefined) {
    return (
      <div className="card">
        <Skeleton label="Loading the project's credentials" lines={2} />
      </div>
    );
  }
  if (shared.data.length === 0) {
    return (
      <p className="card t-meta px-5 py-4">
        You manage no credential of {project.name} in {environment}.{" "}
        <Link className="linkish" search={{ project: project.slug }} to="/credentials">
          Its credentials
        </Link>
      </p>
    );
  }
  return (
    <div className="card rows overflow-hidden" data-testid="shared-credentials">
      {shared.data.map(({ credential, shares }) => (
        <SharedCredentialRow
          credential={credential}
          key={`${credential.kind}:${credential.name}`}
          project={project}
          shares={shares}
        />
      ))}
    </div>
  );
}

function SharedCredentialRow(props: {
  readonly credential: CredentialRef;
  readonly project: Project;
  readonly shares: readonly CredentialShare[];
}) {
  const { credential, project, shares } = props;
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const now = useNow();
  const others = (useProjects().data ?? []).filter((candidate) => candidate.id !== project.id);
  const [target, setTarget] = useState("");
  const offer = useMutation({
    mutationFn: () => api.offerCredentialShare(credential, target),
    onSuccess: async () => {
      setTarget("");
      await refreshAll(queryClient);
    },
  });
  const withdraw = useMutation({
    mutationFn: (share: CredentialShare) =>
      api.withdrawCredentialShare(credential, share.project.id),
    onSettled: () => refreshAll(queryClient),
  });
  const offerable = others.filter(
    (candidate) => !shares.some((share) => share.project.id === candidate.id),
  );
  const failed = offer.error ?? withdraw.error;
  return (
    <div className="setting items-start" data-testid="shared-credential">
      <div className="grid min-w-0 gap-1.5">
        <div>
          <span className="mono font-semibold">{credential.name}</span>{" "}
          <Chip tone="idle">{KIND_LABEL[credential.kind]}</Chip>
        </div>
        {shares.length === 0 ? (
          <span className="t-meta">Shared with no other project.</span>
        ) : (
          shares.map((share) => (
            <span className="flex flex-wrap items-center gap-2" key={share.shareId}>
              <span className="t-meta">{credentialShareInWords(share, now)}</span>
              <button
                aria-label={`Withdraw ${credential.name} from ${share.project.name}`}
                className="btn quiet small"
                disabled={withdraw.isPending}
                onClick={() => withdraw.mutate(share)}
                type="button"
              >
                Withdraw
              </button>
            </span>
          ))
        )}
        {failed ? <ActionError error={failed} /> : null}
      </div>
      {offerable.length === 0 ? null : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (target !== "" && !offer.isPending) offer.mutate();
          }}
        >
          <select
            aria-label={`Project to offer ${credential.name} to`}
            className="field small w-auto"
            onChange={(event) => setTarget(event.target.value)}
            value={target}
          >
            <option value="">Offer to…</option>
            {offerable.map((candidate) => (
              <option key={candidate.id} value={candidate.slug}>
                {candidate.name}
              </option>
            ))}
          </select>
          <button className="btn small" disabled={target === "" || offer.isPending} type="submit">
            {offer.isPending ? "Offering…" : "Offer"}
          </button>
        </form>
      )}
    </div>
  );
}
