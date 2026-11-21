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
import { MenuItem, RowMenu } from "./menu";
import { accessChanged, placeOf, subjectKey, subjectRef } from "./share-form";

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
  const nameOf = (automationId: string) =>
    automations.find((automation) => automation.automationId === automationId)?.automationName ??
    slugOf(automationId);
  const remove = useMutation({
    mutationFn: (grant: AccessGrant) =>
      api.removeGrant(access.project.slug, subjectRef(grant.subject), placeOf(grant, slugOf)),
    onSettled: () => accessChanged(queryClient),
  });

  if (props.holders.length === 0) {
    return <p className="card t-meta px-4 py-4">Nobody holds a role here yet</p>;
  }
  return (
    <div className="card rows" data-testid="holders">
      {remove.isError ? (
        <div className="px-4 py-2">
          <ActionError error={remove.error} />
        </div>
      ) : null}
      {props.holders.map((holder) => {
        const key = subjectKey(holder.subject);
        const own = access.grants.filter((grant) => subjectKey(grant.subject) === key);
        return (
          <HolderRow
            action={
              <div className="flex items-center gap-2">
                <button
                  className="btn quiet small"
                  onClick={() => props.onChange(holder.subject)}
                  type="button"
                >
                  Change
                </button>
                {own.length === 0 ? null : (
                  <RowMenu>
                    {own.map((grant) => (
                      <MenuItem
                        danger
                        disabled={remove.isPending}
                        key={JSON.stringify(grant)}
                        onClick={() => remove.mutate(grant)}
                      >
                        Remove {grantInWords(grant, nameOf, null)}
                      </MenuItem>
                    ))}
                  </RowMenu>
                )}
              </div>
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
              <span key={JSON.stringify(grant)}>{grantInWords(grant, nameOf, null)}</span>
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
