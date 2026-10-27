// Settings › People, for owners and admins: invite someone with a role and projects, see and
// revoke pending invitations, and change, suspend or remove the people who have an account, or hand
// one of them a password reset link. The page shows an invitation's or a reset's link once, to copy
// and pass on; with a mail server the invitation also goes out by mail. The API decides who may
// change whom (mayManagePeople in packages/db/src/access.ts); the controls here only hide what it
// would refuse.

import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ActionError } from "../../components/actions";
import { Chip, CopyButton, ErrorNote, Skeleton, useNow } from "../../components/ui";
import type { InstanceRole, Person, ProjectRole, SentInvitationResponse } from "../../lib/api";
import { useDashboardClient } from "../../lib/dashboard-client";
import { useProjects } from "../../lib/queries";
import { expiryInWords } from "../../lib/words/time";

const INSTANCE_ROLES: readonly InstanceRole[] = ["member", "admin", "owner"];
const PROJECT_ROLES: readonly ProjectRole[] = ["viewer", "operator", "editor", "admin"];

/** Whether `me` may change someone who holds `roles` (their current one, and the one given). */
function mayManage(me: InstanceRole, ...roles: readonly InstanceRole[]): boolean {
  return me === "owner" || (me === "admin" && !roles.includes("owner"));
}

export function People(props: {
  readonly me: { readonly id: string; readonly role: InstanceRole };
  readonly mailConfigured: boolean;
}) {
  const { api, authRevision } = useDashboardClient();
  const queryClient = useQueryClient();
  const now = useNow();
  // Keyed by the sign-in, so a person who signs in after another never sees the other's answers.
  const people = useQuery({
    queryFn: () => api.listPeople(),
    queryKey: ["people", authRevision],
  });
  const invitations = useQuery({
    queryFn: () => api.listInvitations(),
    queryKey: ["invitations", authRevision],
  });
  const changed = async () => {
    await queryClient.invalidateQueries({ queryKey: ["people"] });
    await queryClient.invalidateQueries({ queryKey: ["invitations"] });
  };
  const revoke = useMutation({
    mutationFn: (invitationId: string) => api.revokeInvitation(invitationId),
    onSettled: changed,
  });

  return (
    <div className="card rows overflow-hidden" data-testid="people">
      <Invite mailConfigured={props.mailConfigured} me={props.me.role} onSent={changed} />
      {invitations.isError ? (
        <div className="p-4">
          <ErrorNote error={invitations.error} title="The invitations could not be loaded." />
        </div>
      ) : (
        (invitations.data ?? []).map((invitation) => (
          <div className="setting" data-testid="invitation-row" key={invitation.id}>
            <div className="min-w-0">
              <b>{invitation.email}</b> <Chip tone="idle">Invited</Chip>
              <div className="t-faint">
                {invitation.role}
                {invitation.grants.map((grant) => ` · ${grant.project.name} as ${grant.role}`)}
                {" · link "}
                {expiryInWords(invitation.expiresAt, now)}
              </div>
            </div>
            <button
              className="btn quiet small"
              disabled={revoke.isPending || !mayManage(props.me.role, invitation.role)}
              onClick={() => revoke.mutate(invitation.id)}
              type="button"
            >
              Revoke
            </button>
          </div>
        ))
      )}
      {revoke.isError ? (
        <div className="px-[18px] py-2">
          <ActionError error={revoke.error} />
        </div>
      ) : null}
      <PersonRows me={props.me} onChanged={changed} people={people} />
    </div>
  );
}

function PersonRows(props: {
  readonly people: UseQueryResult<readonly Person[]>;
  readonly me: { readonly id: string; readonly role: InstanceRole };
  readonly onChanged: () => Promise<void>;
}) {
  const { people } = props;
  if (people.isError) {
    return (
      <div className="p-4">
        <ErrorNote error={people.error} title="The people could not be loaded." />
      </div>
    );
  }
  if (people.data === undefined) return <Skeleton label="Loading people" lines={2} />;
  return people.data.map((person) => (
    <PersonRow key={person.id} me={props.me} onChanged={props.onChanged} person={person} />
  ));
}

function Invite(props: {
  readonly me: InstanceRole;
  readonly mailConfigured: boolean;
  readonly onSent: () => Promise<void>;
}) {
  const { api } = useDashboardClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InstanceRole>("member");
  // The projects the invitation grants, by project id, each with its role.
  const [grants, setGrants] = useState<ReadonlyMap<string, ProjectRole>>(new Map());
  const projects = useProjects();
  // The last invitation's link, kept apart from the request so a later request cannot hide it.
  // Without mail it is the only copy, so the next invitation waits until the inviter is done.
  const [shown, setShown] = useState<SentInvitationResponse | null>(null);
  const invite = useMutation({
    mutationFn: () =>
      api.invite({
        email: email.trim(),
        // Only a member's access comes from grants; the picker is hidden for the other roles.
        projects:
          role === "member"
            ? [...grants].map(([project, projectRole]) => ({ project, role: projectRole }))
            : [],
        role,
      }),
    onSuccess: async (sent) => {
      setShown(sent);
      setEmail("");
      setGrants(new Map());
      await props.onSent();
    },
  });
  const setGrant = (projectId: string, projectRole: ProjectRole | null) => {
    const next = new Map(grants);
    if (projectRole === null) next.delete(projectId);
    else next.set(projectId, projectRole);
    setGrants(next);
  };
  const ready = shown === null && email.trim().includes("@") && !invite.isPending;

  return (
    <form
      className="setting items-start"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) invite.mutate();
      }}
    >
      <div className="grid gap-3">
        {props.mailConfigured ? null : (
          <p className="t-meta m-0">
            This instance sends no mail, so you get a link to send the person yourself.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="form-label min-w-0 flex-1">
            Email
            <input
              autoComplete="off"
              className="field"
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="anna@example.com"
              type="email"
              value={email}
            />
          </label>
          <label className="form-label">
            Role
            <select
              className="field"
              onChange={(event) => setRole(event.target.value as InstanceRole)}
              value={role}
            >
              {INSTANCE_ROLES.filter((option) => mayManage(props.me, option)).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
        {role === "member" ? (
          <fieldset className="grid gap-1.5 border-0 p-0">
            <legend className="form-label mb-1.5">Projects</legend>
            {projects.isError ? (
              <ErrorNote error={projects.error} title="The projects could not be loaded." />
            ) : (
              (projects.data ?? []).map((project) => {
                const granted = grants.get(project.id);
                return (
                  <div className="flex items-center gap-3" key={project.id}>
                    <label className="flex min-w-[160px] items-center gap-2">
                      <input
                        checked={granted !== undefined}
                        onChange={(event) =>
                          setGrant(project.id, event.target.checked ? "viewer" : null)
                        }
                        type="checkbox"
                      />
                      {project.name}
                    </label>
                    {granted === undefined ? null : (
                      <select
                        aria-label={`Role in ${project.name}`}
                        className="field small"
                        onChange={(event) =>
                          setGrant(project.id, event.target.value as ProjectRole)
                        }
                        value={granted}
                      >
                        {PROJECT_ROLES.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })
            )}
            <span className="t-faint">A member sees only these projects.</span>
          </fieldset>
        ) : (
          <span className="t-faint">
            {role === "owner"
              ? "An owner manages the instance, every project and its people, owners included."
              : "An admin manages the instance and every project, and people other than owners."}
          </span>
        )}
        {invite.isError ? <ActionError error={invite.error} /> : null}
        {shown === null ? null : (
          <InvitationLink invitation={shown} onDone={() => setShown(null)} />
        )}
      </div>
      <button className="btn" disabled={!ready} type="submit">
        {inviteLabel(invite.isPending, props.mailConfigured)}
      </button>
    </form>
  );
}

function inviteLabel(pending: boolean, mailConfigured: boolean): string {
  if (pending) return "Inviting…";
  if (mailConfigured) return "Send invitation";
  return "Create link";
}

/**
 * A new invitation's link, shown once: the person's way in, by mail or from the inviter. "Done"
 * dismisses it and lets the form invite the next person.
 */
function InvitationLink(props: {
  readonly invitation: SentInvitationResponse;
  readonly onDone: () => void;
}) {
  const { invitation } = props;
  const until = new Date(invitation.expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
  });
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="invitation-link" role="status">
      <span className="t-meta basis-full">
        {invitation.mailed
          ? `Invitation sent to ${invitation.email}. If the mail does not arrive, send them this link yourself.`
          : `Send this link to ${invitation.email}.`}{" "}
        It creates one account for this address, until {until}. It is shown only now; select Done to
        invite the next person.
      </span>
      <input
        aria-label={`Invitation link for ${invitation.email}`}
        className="field mono small min-w-0 flex-1"
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        value={invitation.url}
      />
      <CopyButton className="btn small" label="Copy link" text={invitation.url} />
      <button className="btn quiet small" onClick={props.onDone} type="button">
        Done
      </button>
    </div>
  );
}

function PersonRow(props: {
  readonly person: Person;
  readonly me: { readonly id: string; readonly role: InstanceRole };
  readonly onChanged: () => Promise<void>;
}) {
  const { api } = useDashboardClient();
  const { person, me } = props;
  const change = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => await action(),
    onSettled: props.onChanged,
  });
  const resetLink = useMutation({ mutationFn: async () => await api.createResetLink(person.id) });
  const self = person.id === me.id;
  const manageable = mayManage(me.role, person.role);
  const confirmThen = (question: string, action: () => Promise<unknown>) => {
    if (window.confirm(question)) change.mutate(action);
  };

  return (
    <div className="setting" data-testid="person-row">
      <div className="min-w-0">
        <b>{person.name}</b> <span className="t-faint">{person.email}</span>
        {self ? <span className="t-faint"> (you)</span> : null}{" "}
        {person.suspended ? <Chip tone="fail">Suspended</Chip> : null}{" "}
        {person.twoFactorEnabled ? <Chip tone="ok">Two-factor on</Chip> : null}
        {change.isError ? <ActionError error={change.error} /> : null}
        {resetLink.isError ? <ActionError error={resetLink.error} /> : null}
        {resetLink.isSuccess ? (
          <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="reset-link">
            <span className="t-meta basis-full">
              Send this link to {person.name}. It sets a new password once, until{" "}
              {new Date(resetLink.data.expiresAt).toLocaleTimeString("en-GB")}; using it signs them
              out everywhere and revokes their agent tokens. It is shown only now.
            </span>
            <input
              aria-label={`Reset link for ${person.name}`}
              className="field mono small min-w-0 flex-1"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={resetLink.data.url}
            />
            <CopyButton className="btn small" label="Copy link" text={resetLink.data.url} />
            <button className="btn quiet small" onClick={() => resetLink.reset()} type="button">
              Done
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <select
          aria-label={`Role of ${person.name}`}
          className="field small"
          disabled={!manageable || self || change.isPending}
          onChange={(event) => {
            const role = event.target.value as InstanceRole;
            change.mutate(() => api.setRole(person.id, role));
          }}
          value={person.role}
        >
          {INSTANCE_ROLES.map((option) => (
            <option disabled={!mayManage(me.role, person.role, option)} key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {manageable && person.twoFactorEnabled && !self ? (
          <button
            className="btn quiet small"
            disabled={change.isPending}
            onClick={() =>
              confirmThen(
                `Turn off two-factor sign-in for ${person.name}? They sign in with the password alone until they set it up again.`,
                () => api.resetTwoFactor(person.id),
              )
            }
            type="button"
          >
            Turn off two-factor
          </button>
        ) : null}
        {manageable && !self ? (
          <button
            className="btn quiet small"
            disabled={resetLink.isPending}
            onClick={() => resetLink.mutate()}
            type="button"
          >
            {resetLink.isPending ? "Creating…" : "Reset link"}
          </button>
        ) : null}
        {manageable && !self ? (
          <button
            className="btn quiet small"
            disabled={change.isPending}
            onClick={() =>
              person.suspended
                ? change.mutate(() => api.setSuspended(person.id, false))
                : confirmThen(
                    `Suspend ${person.name}? They are signed out at once and their agent tokens stop working.`,
                    () => api.setSuspended(person.id, true),
                  )
            }
            type="button"
          >
            {person.suspended ? "Reactivate" : "Suspend"}
          </button>
        ) : null}
        {manageable && !self ? (
          <button
            className="btn danger small"
            disabled={change.isPending}
            onClick={() =>
              confirmThen(
                `Remove ${person.name}? Their account, grants and agent tokens are deleted. Their automations and runs stay.`,
                () => api.removePerson(person.id),
              )
            }
            type="button"
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}
