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
