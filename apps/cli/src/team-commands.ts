import type {
  CreateTeamResponse as CreateTeamResult,
  DeleteTeamResponse as DeleteTeamResult,
  TeamMembershipResponse as MembershipResult,
  TeamsResponse,
} from "@swizzle/runtime/http-contract";
import type { Command } from "commander";

import { apiRequest } from "./api.js";
import {
  type ApiCommandOptions,
  type RunHandler,
  requireYes,
  buildAccessApiUrl as url,
  withExamples,
} from "./command-support.js";
import { AgentError, type CliIO, EXIT_CODES, respond } from "./output.js";
import { listPeople } from "./people-commands.js";

type Team = TeamsResponse["teams"][number];

const segment = encodeURIComponent;

async function listTeams(options: ApiCommandOptions): Promise<readonly Team[]> {
  return (await apiRequest<TeamsResponse>(url("/teams", options))).teams;
}

async function findTeam(reference: string, options: ApiCommandOptions): Promise<Team | undefined> {
  return (await listTeams(options)).find(
    (team) => team.name === reference || team.id === reference,
  );
}

function teamNotFound(reference: string): AgentError {
  return new AgentError({
    code: "TEAM_NOT_FOUND",
    exitCode: EXIT_CODES.notFound,
    fixCommand: "swizzle teams",
    message: `No team ${reference}.`,
  });
}

export function registerTeams(program: Command, io: CliIO, runHandler: RunHandler): void {
  const teams = program
    .command("teams")
    .description("List teams and manage their members (instance owners and admins)");
  withExamples(teams, ["swizzle teams", "swizzle teams add Developers anna@example.com"]);

  const list = teams
    .command("list", { isDefault: true })
    .description("List teams with their member count (instance owners and admins)");
  withExamples(list, ["swizzle teams list", "swizzle teams list --json"]);
  list.action(async (options: ApiCommandOptions) => {
    await runHandler(async () => {
      const rows = (await listTeams(options)).map((team) => ({
        name: team.name,
        members: team.memberIds.length,
      }));
      if (rows.length === 0) {
        respond(io, { teams: "0 teams on this instance" }, [
          "Run `swizzle teams create <name>` to create one",
        ]);
        return;
      }
      respond(io, { count: rows.length, teams: rows }, [
        "Run `swizzle teams members <name>` for a team's members",
      ]);
    });
  });

  const create = teams
    .command("create")
    .description("Create a team; an existing name is a no-op")
    .argument("<name>", "Team name");
  withExamples(create, ["swizzle teams create Developers", "swizzle teams create Release --json"]);
  create.action(async (name: string, options: ApiCommandOptions) => {
    await runHandler(async () => {
      const created = await apiRequest<CreateTeamResult>(url("/teams", options), {
        body: JSON.stringify({ name }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      respond(
        io,
        { team: created.name, state: created.changed ? "created" : "already exists (no-op)" },
        [
          `Run \`swizzle teams add ${name} <email>\` to add a member`,
          `Run \`swizzle projects grant <project> --team ${name} --role <role>\` to give it a role`,
        ],
      );
    });
  });

  const remove = teams
    .command("delete")
    .description("Delete a team and its grants; a missing team is a no-op")
    .argument("<team>", "Team name or id")
    .option("--yes", "Confirm the delete (required)");
  withExamples(remove, [
    "swizzle teams delete Contractors --yes",
    "swizzle teams delete Contractors --yes --json",
  ]);
  remove.action(
    async (reference: string, options: ApiCommandOptions & { readonly yes?: boolean }) => {
      await runHandler(async () => {
        requireYes(
          options.yes,
          `swizzle teams delete ${reference}`,
          `this deletes team ${reference}; its members lose every role the team's grants give them.`,
        );
        const result = await apiRequest<DeleteTeamResult>(
          url(`/teams/${segment(reference)}`, options),
          { method: "DELETE" },
        );
        respond(io, {
          team: result.team,
          state: result.changed ? "deleted" : "already absent (no-op)",
        });
      });
    },
  );

  const members = teams
    .command("members")
    .description("List a team's members")
    .argument("<team>", "Team name or id");
  withExamples(members, [
    "swizzle teams members Developers",
    "swizzle teams members Release --json",
  ]);
  members.action(async (reference: string, options: ApiCommandOptions) => {
    await runHandler(async () => {
      const team = await findTeam(reference, options);
      if (team === undefined) throw teamNotFound(reference);
      const people = await listPeople(options);
      const rows = team.memberIds.map((id) => {
        const person = people.find((candidate) => candidate.id === id);
        return { email: person?.email ?? id, name: person?.name ?? null };
      });
      if (rows.length === 0) {
        respond(io, { team: team.name, members: "0 members" }, [
          `Run \`swizzle teams add ${team.name} <email>\` to add one`,
        ]);
        return;
      }
      respond(io, { team: team.name, count: rows.length, members: rows });
    });
  });

  for (const member of [true, false]) {
    const name = member ? "add" : "remove";
    const command = teams
      .command(name)
      .description(
        member
          ? "Add a person to a team; a member already is a no-op"
          : "Remove a person from a team; someone not in it is a no-op",
      )
      .argument("<team>", "Team name or id")
      .argument("<person>", "Email or user id");
    withExamples(command, [
      `swizzle teams ${name} Developers anna@example.com`,
      `swizzle teams ${name} Release ben@example.com --json`,
    ]);
    command.action(
      async (teamReference: string, personReference: string, options: ApiCommandOptions) => {
        await runHandler(async () => {
          const result = await apiRequest<MembershipResult>(
            url(`/teams/${segment(teamReference)}/members/${segment(personReference)}`, options),
            { method: member ? "PUT" : "DELETE" },
          );
          let state: string;
          if (member) state = result.changed ? "added" : "already a member (no-op)";
          else state = result.changed ? "removed" : "not a member (no-op)";
          respond(io, {
            team: result.team,
            person: result.person,
            state,
          });
        });
      },
    );
  }
}
