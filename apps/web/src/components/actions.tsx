import { approvalDetailsInWords } from "@swizzle/config/browser";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { useDashboardClient } from "../lib/dashboard-client";
import { refreshAll, useDirectory } from "../lib/queries";
import { SecretInput } from "./secret-input";
import { errorText } from "./ui";

export function ApprovalDetails(props: { readonly details: unknown; readonly stacked?: boolean }) {
  const { fields, heading } = approvalDetailsInWords(props.details);
  if (heading === null && fields.length === 0) return null;
  return (
    <div className="t-meta grid gap-1">
      {heading === null ? null : <div className="break-words">{heading}</div>}
      {fields.length === 0 ? null : (
        <dl
          className={`m-0 grid gap-x-3 ${props.stacked ? "grid-cols-1" : "grid-cols-[auto_minmax(0,1fr)]"}`}
        >
          {fields.map((field) => (
            <Fragment key={field.label}>
              <dt className="t-faint">{field.label}</dt>
              <dd className={`m-0 min-w-0 break-words ${field.json ? "mono" : ""}`}>
                {field.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

type ApprovalMay = { readonly decide: boolean; readonly reassign: boolean };

export function ApprovalActions(props: {
  readonly runId: string;
  readonly stepKey: string;
  readonly may?: ApprovalMay;
}) {
  const may = props.may ?? { decide: true, reassign: false };
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const [reassigning, setReassigning] = useState(false);
  const decide = useMutation({
    mutationFn: (approved: boolean) =>
      api.decideApproval(props.runId, props.stepKey, {
        approved,
        ...(comment.trim() === "" ? {} : { comment: comment.trim() }),
      }),
    onSuccess: () => refreshAll(queryClient),
  });
  if (reassigning) {
    return (
      <ReassignForm
        onDone={() => setReassigning(false)}
        runId={props.runId}
        stepKey={props.stepKey}
      />
    );
  }
  const reassignButton = may.reassign ? (
    <button className="btn quiet" onClick={() => setReassigning(true)} type="button">
      Reassign
    </button>
  ) : null;
  return (
    <>
      {may.decide ? (
        <>
          <input
            aria-label="Comment"
            className="field"
            onChange={(event) => setComment(event.target.value)}
            placeholder="Comment (optional)"
            value={comment}
          />
          <span className="flex flex-wrap gap-2">
            <button
              className="btn ok"
              disabled={decide.isPending}
              onClick={() => decide.mutate(true)}
              type="button"
            >
              Approve
            </button>
            <button
              className="btn quiet"
              disabled={decide.isPending}
              onClick={() => decide.mutate(false)}
              type="button"
            >
              Reject
            </button>
            {reassignButton}
          </span>
        </>
      ) : (
        reassignButton
      )}
      {decide.isError ? <ActionError error={decide.error} /> : null}
    </>
  );
}

function ReassignForm(props: {
  readonly runId: string;
  readonly stepKey: string;
  readonly onDone: () => void;
}) {
  const { api } = useDashboardClient();
  const directory = useDirectory();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"team" | "user">("user");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const reassign = useMutation({
    mutationFn: () =>
      api.reassignApproval(props.runId, props.stepKey, {
        ...(kind === "user" ? { user: to.trim() } : { team: to.trim() }),
        reason: reason.trim(),
      }),
    onSuccess: async () => {
      props.onDone();
      await refreshAll(queryClient);
    },
  });
  const ready = to.trim() !== "" && reason.trim() !== "" && !reassign.isPending;
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) reassign.mutate();
      }}
    >
      <select
        aria-label="Person or team"
        className="field"
        onChange={(event) => setKind(event.target.value === "team" ? "team" : "user")}
        value={kind}
      >
        <option value="user">Person</option>
        <option value="team">Team</option>
      </select>
      <input
        aria-label="Assign to"
        list={`assignees-${props.runId}-${props.stepKey}`}
        className="field"
        onChange={(event) => setTo(event.target.value)}
        placeholder={kind === "user" ? "Email" : "Team name"}
        value={to}
      />
      <datalist id={`assignees-${props.runId}-${props.stepKey}`}>
        {kind === "user"
          ? directory.data?.users.map((person) => (
              <option key={person.id} value={person.email}>
                {person.name}
              </option>
            ))
          : directory.data?.teams.map((team) => <option key={team.id} value={team.name} />)}
      </datalist>
      {directory.isError ? <ActionError error={directory.error} /> : null}
      <input
        aria-label="Reason"
        className="field"
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason"
        value={reason}
      />
      <button className="btn" disabled={!ready} type="submit">
        {reassign.isPending ? "Reassigning…" : "Reassign"}
      </button>
      <button className="btn quiet" onClick={props.onDone} type="button">
        Cancel
      </button>
      {reassign.isError ? <ActionError error={reassign.error} /> : null}
    </form>
  );
}

export function SecretField(props: {
  readonly name: string;
  readonly projectId: string;
  readonly overwrite?: boolean;
  readonly onSaved?: () => void;
}) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api.upsertSecret(props.name, value, {
        overwrite: props.overwrite === true,
        project: props.projectId,
      }),
    onSuccess: async () => {
      setValue("");
      props.onSaved?.();
      await refreshAll(queryClient);
    },
  });
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== "" && !save.isPending) save.mutate();
      }}
    >
      <SecretInput
        aria-label={`Value of ${props.name}`}
        onValueChange={setValue}
        placeholder="Paste the value"
        value={value}
      />
      <button className="btn" disabled={value === "" || save.isPending} type="submit">
        {save.isPending ? "Saving…" : "Save"}
      </button>
      {save.isError ? <ActionError error={save.error} /> : null}
    </form>
  );
}

export function ConnectLink(props: {
  readonly name: string;
  readonly projectId: string;
  readonly provider: string | null;
}) {
  return (
    <Link
      className="btn"
      search={{
        name: props.name,
        project: props.projectId,
        ...(props.provider === null ? {} : { connect: props.provider }),
      }}
      to="/credentials"
    >
      Connect
    </Link>
  );
}

export function ActionError(props: { readonly error: unknown }) {
  return (
    <span className="basis-full text-right text-[13px] text-fail" role="alert">
      {errorText(props.error)}
    </span>
  );
}
