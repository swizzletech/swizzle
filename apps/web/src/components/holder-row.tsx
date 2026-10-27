// One holder of access as every holder list shows them: name, email, what kind of holder, a
// suspension and a team's size, then what they hold, then the row's one action. The Access tab,
// a service account's card and a credential's access list use it.

import type { ReactNode } from "react";

import type { Holder } from "../lib/api";
import { Chip } from "./ui";

function holderKind(holder: Holder): string {
  if (holder.subject.kind === "team") return "Team";
  if (holder.subject.kind === "service-account") return "Service account";
  return holder.instanceRole === null ? "Person" : `Instance ${holder.instanceRole}`;
}

export function HolderRow(props: {
  readonly holder: Holder;
  readonly testId: string;
  /** Chips after the holder's kind, such as their right on a credential. */
  readonly chips?: ReactNode;
  /** What they hold and where it comes from, one line each. */
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  const { holder } = props;
  return (
    <div className="setting items-start" data-testid={props.testId}>
      <div className="grid min-w-0 gap-1.5">
        <div>
          <b>{holder.name}</b>{" "}
          {holder.email === null ? null : <span className="t-faint">{holder.email}</span>}{" "}
          <Chip tone="idle">{holderKind(holder)}</Chip>
          {props.chips}
          {holder.suspended ? (
            <>
              {" "}
              <Chip tone="fail">Suspended: may do nothing</Chip>
            </>
          ) : null}
          {holder.members === null ? null : (
            <span className="t-faint">
              {" "}
              · {holder.members} {holder.members === 1 ? "person" : "people"}
            </span>
          )}
        </div>
        {props.children}
      </div>
      {props.action}
    </div>
  );
}
