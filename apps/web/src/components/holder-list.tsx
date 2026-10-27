// A project's holders of access as rows: each person, team or service account with the role the
// API's policy gives them per environment, every grant of theirs with Remove, and the grants that
// reach a person through a team. The Access tab lists people and teams; each service account
// shows its own row.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  AccessGrant,
  EnvironmentHold,
  ProjectAccess,
  ProjectHolder,
  Subject,
} from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { useAutomations } from "../lib/queries";
import { grantInWords } from "../lib/words/access";
import { ActionError } from "./actions";
import { HolderRow } from "./holder-row";
import { accessChanged, placeOf, subjectKey, subjectRef } from "./share-form";

/** Holder rows: what each may do per environment, and each grant with its remove button. */
export function HolderList(props: {
  readonly access: ProjectAccess;
  readonly holders: readonly ProjectHolder[];
  readonly onChange: (subject: Subject) => void;
}) {
  const { access } = props;
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const automations = useAutomations().data ?? [];
  const slugOf = (automationId: string) => access.automationSlugs[automationId] ?? automationId;
  // An automation not deployed in the shown environment has no name here; its slug stands in.
  const nameOf = (automationId: string) =>
    automations.find((automation) => automation.automationId === automationId)?.automationName ??
    slugOf(automationId);
  const remove = useMutation({
    mutationFn: (grant: AccessGrant) =>
      api.removeGrant(access.project.slug, subjectRef(grant.subject), placeOf(grant, slugOf)),
    onSettled: () => accessChanged(queryClient),
  });

  if (props.holders.length === 0) {
    return <p className="card t-meta px-5 py-4">Nobody holds a role here yet.</p>;
  }
  return (
    <div className="card rows overflow-hidden" data-testid="holders">
      {remove.isError ? (
        <div className="px-[18px] py-2">
          <ActionError error={remove.error} />
        </div>
      ) : null}
      {props.holders.map((holder) => {
        const key = subjectKey(holder.subject);
        const own = access.grants.filter((grant) => subjectKey(grant.subject) === key);
        return (
          <HolderRow
            action={
              <button
                className="btn quiet small"
                onClick={() => props.onChange(holder.subject)}
                type="button"
              >
                Change
              </button>
            }
            holder={holder}
            key={key}
            testId="holder"
          >
            <EnvironmentRoles access={access} holder={holder} />
            {holder.instanceRole !== null ? (
              <span className="t-faint">
                Admin of every project by instance role; that access is audited.
              </span>
            ) : null}
            {own.map((grant) => (
              <span className="flex flex-wrap items-center gap-2" key={JSON.stringify(grant)}>
                <span>{grantInWords(grant, nameOf, null)}</span>
                <button
                  aria-label={`Remove ${grantInWords(grant, nameOf, null)} from ${holder.name}`}
                  className="btn quiet small"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(grant)}
                  type="button"
                >
                  Remove
                </button>
              </span>
            ))}
            {holder.teamGrants.map(({ grant, teamName }) => (
              <span className="t-meta" key={`${teamName}:${JSON.stringify(grant)}`}>
                {grantInWords(grant, nameOf, teamName)}
              </span>
            ))}
          </HolderRow>
        );
      })}
    </div>
  );
}

/**
 * "staging: editor · production (protected): no access": what the policy gives the holder in each
 * environment. A team's grant in a protected environment gives nothing by itself; it caps what
 * its members' project role does there, so it reads as that cap.
 */
function EnvironmentRoles(props: {
  readonly access: ProjectAccess;
  readonly holder: ProjectHolder;
}) {
  const entries = Object.entries(props.holder.environments);
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]" data-testid="environment-roles">
      <span>
        Project:{" "}
        {props.holder.role === null ? (
          <span className="t-faint">no access</span>
        ) : (
          <b>{props.holder.role}</b>
        )}
      </span>
      {entries.map(([environment, hold]) => (
        <span key={environment}>
          {environment}
          {props.access.protectedEnvironments.includes(environment) ? " (protected)" : ""}:{" "}
          <HoldName hold={hold} team={props.holder.subject.kind === "team"} />
        </span>
      ))}
    </span>
  );
}

function HoldName({ hold, team }: { readonly hold: EnvironmentHold; readonly team: boolean }) {
  if (team && hold.cap !== null)
    return (
      <>
        caps members at <b>{hold.cap}</b>
      </>
    );
  if (hold.role !== null) return <b>{hold.role}</b>;
  if (hold.cap !== null) {
    return <span className="t-faint">no access: capped at {hold.cap}, but no project role</span>;
  }
  return <span className="t-faint">no access</span>;
}
