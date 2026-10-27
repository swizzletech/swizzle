// Settings › Teams, for owners and admins: create and delete teams and choose their members. A
// project's admins then give a team a role on the project's Access tab; every member gets it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ActionError } from "../../components/actions";
import { accessChanged } from "../../components/share-form";
import { ErrorNote, Skeleton } from "../../components/ui";
import type { Person, Team } from "../../lib/api";
import { useDashboardClient } from "../../lib/dashboard-client";

export function Teams() {
  const { api, authRevision } = useDashboardClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const teams = useQuery({ queryFn: () => api.listTeams(), queryKey: ["teams", authRevision] });
  const people = useQuery({ queryFn: () => api.listPeople(), queryKey: ["people", authRevision] });
  const changed = async () => {
    await queryClient.invalidateQueries({ queryKey: ["teams"] });
    await accessChanged(queryClient);
  };
  const create = useMutation({
    mutationFn: () => api.createTeam(name.trim()),
    onSuccess: async () => {
      setName("");
      await changed();
    },
  });

  return (
    <div className="card rows overflow-hidden" data-testid="teams">
      <form
        className="setting"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== "" && !create.isPending) create.mutate();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="form-label min-w-0 flex-1">
            Team name
            <input
              autoComplete="off"
              className="field"
              onChange={(event) => setName(event.target.value)}
              placeholder="Büro"
              value={name}
            />
          </label>
          {create.isError ? <ActionError error={create.error} /> : null}
        </div>
        <button className="btn" disabled={name.trim() === "" || create.isPending} type="submit">
          Create team
        </button>
      </form>
      {teams.isError || people.isError ? (
        <div className="p-4">
          <ErrorNote
            error={teams.error ?? people.error}
            title="The teams and their members could not be loaded."
          />
        </div>
      ) : teams.data === undefined || people.data === undefined ? (
        <Skeleton label="Loading teams" lines={2} />
      ) : (
        teams.data.map((team) => (
          <TeamRow key={team.id} onChanged={changed} people={people.data} team={team} />
        ))
      )}
    </div>
  );
}

function TeamRow(props: {
  readonly team: Team;
  readonly people: readonly Person[];
  readonly onChanged: () => Promise<void>;
}) {
  const { team, people } = props;
  const { api } = useDashboardClient();
  const change = useMutation({
    mutationFn: async (action: () => Promise<void>) => await action(),
    onSettled: props.onChanged,
  });
  const members = people.filter((person) => team.memberIds.includes(person.id));
  const others = people.filter((person) => !team.memberIds.includes(person.id));
  return (
    <div className="setting items-start" data-testid="team-row">
      <div className="grid min-w-0 gap-2">
        <b>{team.name}</b>
        <div className="flex flex-wrap gap-2">
          {members.length === 0 ? <span className="t-faint">No members yet.</span> : null}
          {members.map((person) => (
            <span className="chip idle" key={person.id}>
              {person.name}
              <button
                aria-label={`Remove ${person.name} from ${team.name}`}
                className="ml-1"
                disabled={change.isPending}
                onClick={() => change.mutate(() => api.setTeamMember(team.id, person.id, false))}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        {others.length === 0 ? null : (
          <select
            aria-label={`Add someone to ${team.name}`}
            className="field small justify-self-start"
            disabled={change.isPending}
            onChange={(event) => {
              const userId = event.target.value;
              if (userId !== "") change.mutate(() => api.setTeamMember(team.id, userId, true));
            }}
            value=""
          >
            <option value="">Add someone…</option>
            {others.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} ({person.email})
              </option>
            ))}
          </select>
        )}
        {change.isError ? <ActionError error={change.error} /> : null}
      </div>
      <button
        className="btn danger small"
        disabled={change.isPending}
        onClick={() => {
          if (
            window.confirm(
              `Delete the team ${team.name}? Its members lose every role the team gave them.`,
            )
          ) {
            change.mutate(() => api.deleteTeam(team.id));
          }
        }}
        type="button"
      >
        Delete team
      </button>
    </div>
  );
}
