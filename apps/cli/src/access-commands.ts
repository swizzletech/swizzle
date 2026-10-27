/**
 * Projects, teams and people (ADR 0014) over the API the dashboard uses, so the CLI has the same
 * rights as the dashboard: the API decides every change, the CLI only names it.
 *
 * | Command                                              | API                                         |
 * |------------------------------------------------------|---------------------------------------------|
 * | projects [list]                                      | GET /projects                               |
 * | projects create <slug> --name <name>                 | POST /projects                              |
 * | projects delete <project> --yes [+ contents choice]  | DELETE /projects/:project                   |
 * | projects access <project>                            | GET /projects/:project/access               |
 * | projects grant / revoke <project> <subject> ...      | PUT / DELETE /projects/:project/grants      |
 * | projects protect / unprotect <project> <environment> | PUT / DELETE …/environments/:e/protection   |
 * | teams [list], teams create / delete <team>           | GET, POST /teams, DELETE /teams/:team       |
 * | teams members / add / remove <team> [person]         | PUT / DELETE /teams/:team/members/:person   |
 * | people                                               | GET /users                                  |
 * | people invite <email> --role <role> [--project p=r]  | POST /invitations                           |
 * | people reset-link <person>                           | POST /users/:userId/reset-link              |
 * | service-accounts [list] / create / delete            | GET, POST, DELETE …/service-accounts[/:a]   |
 * | service-accounts token create / rotate / revoke      | none: a token never manages tokens          |
 *
 * A subject is `--user <email|id>`, `--team <name|id>` or `--service-account <name|id>`, exactly
 * one. Mutations converge: a grant, membership or protection that already holds, or a removal of
 * something already gone, answers as a no-op with exit 0. Writes report their outcome from the
 * API, including destructive confirmation requirements. Each group is its own module:
 * project-commands.ts, team-commands.ts, people-commands.ts and service-account-commands.ts.
 */
import type { Command } from "commander";

import type { RunHandler } from "./command-support.js";
import type { CliIO } from "./output.js";
import { registerPeople } from "./people-commands.js";
import { registerProjects } from "./project-commands.js";
import { registerServiceAccounts } from "./service-account-commands.js";
import { registerTeams } from "./team-commands.js";

export function registerAccessCommands(program: Command, io: CliIO, runHandler: RunHandler): void {
  registerProjects(program, io, runHandler);
  registerTeams(program, io, runHandler);
  registerPeople(program, io, runHandler);
  registerServiceAccounts(program, io, runHandler);
}
