import type {
  CreateServiceAccountResponse as CreateServiceAccountResult,
  DeleteServiceAccountResponse as DeleteServiceAccountResult,
  ServiceAccountsResponse,
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

type ServiceAccount = ServiceAccountsResponse["serviceAccounts"][number];

const segment = encodeURIComponent;

type ProjectOption = ApiCommandOptions & { readonly project?: string };

/** `--project`, or the profile's project, which main.ts fills in. */
function projectOf(options: ProjectOption): string {
  if (options.project !== undefined) return options.project;
  throw new AgentError({
    code: "PROJECT_REQUIRED",
    exitCode: EXIT_CODES.usage,
    hint: "Pass --project <slug>, or set the profile's project with `swizzle profile add <name> --project <slug>`.",
    message: "Service accounts belong to a project; none was named.",
  });
}

async function listServiceAccounts(
  project: string,
  options: ApiCommandOptions,
): Promise<readonly ServiceAccount[]> {
  return (
    await apiRequest<ServiceAccountsResponse>(
      url(`/projects/${segment(project)}/service-accounts`, options),
    )
  ).serviceAccounts;
}

export function registerServiceAccounts(program: Command, io: CliIO, runHandler: RunHandler): void {
  const accounts = program
    .command("service-accounts")
    .description(
      "List, create and delete a project's service accounts, the identities agents and integrations run as (project admins)",
    );
  withExamples(accounts, [
    "swizzle service-accounts --project billing",
    "swizzle service-accounts create ci --project billing",
  ]);

  const list = accounts
    .command("list", { isDefault: true })
    .description("List a project's service accounts with their grants and live tokens")
    .option("--project <project>", "Project slug or id (default: the profile's)");
  withExamples(list, [
    "swizzle service-accounts list --project billing",
    "swizzle service-accounts list --project billing --json",
  ]);
  list.action(async (options: ProjectOption) => {
    await runHandler(async () => {
      const project = projectOf(options);
      const rows = (await listServiceAccounts(project, options)).map((account) => ({
        name: account.name,
        grants:
          account.grants
            .map(
              (grant) =>
                `${grant.on === "environment" ? grant.environment : grant.on}=${grant.role}`,
            )
            .join(" ") || "none",
        liveTokens: account.tokens.filter(
          (token) => token.revokedAt === null && Date.parse(token.expiresAt) > Date.now(),
        ).length,
        createdBy: account.createdBy.name,
      }));
      if (rows.length === 0) {
        respond(io, { serviceAccounts: `0 service accounts in ${project}` }, [
          `Run \`swizzle service-accounts create <name> --project ${project}\` to create one`,
        ]);
        return;
      }
      respond(io, { project, count: rows.length, serviceAccounts: rows }, [
        `Run \`swizzle projects grant ${project} --service-account <name> --role editor\` to give one a role`,
      ]);
    });
  });

  const create = accounts
    .command("create")
    .description("Create a service account; an existing name is a no-op. A person mints its token")
    .argument("<name>", "Account name, such as ci")
    .option("--project <project>", "Project slug or id (default: the profile's)");
  withExamples(create, [
    "swizzle service-accounts create ci --project billing",
    "swizzle service-accounts create invoice-bot --project billing --json",
  ]);
  create.action(async (name: string, options: ProjectOption) => {
    await runHandler(async () => {
      const project = projectOf(options);
      const next = [
        `Run \`swizzle projects grant ${project} --service-account ${name} --role editor\` to give it a role`,
        `Sign in to the dashboard and open ${project} > Service accounts > ${name} to mint its token`,
      ];
      const created = await apiRequest<CreateServiceAccountResult>(
        url(`/projects/${segment(project)}/service-accounts`, options),
        {
          body: JSON.stringify({ name }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      respond(
        io,
        {
          project,
          serviceAccount: created.name,
          state: created.changed ? "created" : "already exists (no-op)",
        },
        next,
      );
    });
  });

  const remove = accounts
    .command("delete")
    .description("Delete a service account with its grants and tokens; a missing one is a no-op")
    .argument("<name>", "Account name or id")
    .option("--project <project>", "Project slug or id (default: the profile's)")
    .option("--yes", "Confirm the delete (required)");
  withExamples(remove, [
    "swizzle service-accounts delete ci --project billing --yes",
    "swizzle service-accounts delete invoice-bot --project billing --yes --json",
  ]);
  remove.action(async (name: string, options: ProjectOption & { readonly yes?: boolean }) => {
    await runHandler(async () => {
      const project = projectOf(options);
      requireYes(
        options.yes,
        `swizzle service-accounts delete ${name} --project ${project}`,
        `this deletes service account ${name} of ${project}; every agent using its tokens stops at once.`,
      );
      const result = await apiRequest<DeleteServiceAccountResult>(
        url(`/projects/${segment(project)}/service-accounts/${segment(name)}`, options),
        { method: "DELETE" },
      );
      respond(io, {
        project,
        serviceAccount: result.serviceAccount,
        state: result.changed ? "deleted" : "already absent (no-op)",
      });
    });
  });

  const token = accounts
    .command("token")
    .description(
      "Mint, rotate or revoke a service account's token: only a signed-in person can, in the dashboard",
    );
  withExamples(token, [
    "swizzle service-accounts token create ci --project billing",
    "swizzle service-accounts token revoke ci deploy-token --project billing",
  ]);
  const tokenActions = [
    ["create", "Mint a token for a service account", ["<account>"]],
    ["rotate", "Replace a service account's token with a new one", ["<account>", "<token>"]],
    ["revoke", "Revoke a service account's token", ["<account>", "<token>"]],
  ] as const;
  for (const [action, description, args] of tokenActions) {
    const command = token
      .command(action)
      .description(`${description}. A token cannot; this names where a person does it`)
      .option("--project <project>", "Project slug or id (default: the profile's)");
    for (const arg of args)
      command.argument(arg, arg === "<account>" ? "Account name" : "Token name or id");
    withExamples(command, [
      `swizzle service-accounts token ${action} ci${args.length > 1 ? " deploy-token" : ""} --project billing`,
      `swizzle service-accounts token ${action} invoice-bot${args.length > 1 ? " nightly" : ""} --project billing --json`,
    ]);
    command.action(async (account: string, ...rest: unknown[]) => {
      await runHandler(async () => {
        const options = rest.at(-2) as ProjectOption;
        const project = options.project ?? "<project>";
        throw new AgentError({
          code: "TOKEN_NEEDS_SIGN_IN",
          exitCode: EXIT_CODES.auth,
          hint: `Sign in to the dashboard and open ${project} > Service accounts > ${account} to ${action} its token. A token never mints, rotates or revokes a token.`,
          message: `The CLI acts with a token, so it cannot ${action} a service account's token.`,
        });
      });
    });
  }
}
