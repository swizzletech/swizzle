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
  readonly chips?: ReactNode;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  const { holder } = props;
  return (
    <div className="setting items-start" data-testid={props.testId}>
      <div className="grid min-w-0 gap-2">
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
