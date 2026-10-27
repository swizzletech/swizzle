import type { IdentityResponse as Identity } from "@swizzle/runtime/http-contract";

/**
 * `swizzle profile add | list | use | remove` keep the targets in ~/.swizzle/config.toml and never
 * call the API. `swizzle whoami` asks the API who the resolved profile acts as.
 */
import type { Command } from "commander";

import { apiRequest } from "./api.js";
import {
  type ApiCommandOptions,
  buildApiUrl,
  localCommand,
  type RunHandler,
  withExamples,
} from "./command-support.js";
import { AgentError, type CliIO, EXIT_CODES, respond } from "./output.js";
import {
  assertBearerTokenFlag,
  loadProfileConfig,
  redactedView,
  removeProfile,
  resolveEnvironment,
  resolveProfile,
  type StoredProfile,
  saveProfileConfig,
  setDefaultProfile,
  upsertProfile,
} from "./profile.js";

interface ProfileAddOptions {
  readonly url: string;
  readonly env?: string;
  readonly token?: string;
  readonly tokenEnv?: string;
  readonly project?: string;
  readonly default?: boolean;
}

export function registerProfile(program: Command, io: CliIO, runHandler: RunHandler): void {
  const profile = localCommand(
    program
      .command("profile")
      .description("Manage the CLI's targets: an API URL, a token, an environment and a project"),
  );
  withExamples(profile, [
    "swizzle profile",
    "swizzle profile add prod --url https://swizzle.example.com --token-env SWIZZLE_TOKEN --env prod",
  ]);

  const list = localCommand(
    profile
      .command("list", { isDefault: true })
      .description("List profiles with where each token comes from (tokens never shown)"),
  );
  withExamples(list, ["swizzle profile list", "swizzle profile list --json"]);
  list.action(async () => {
    await runHandler(async () => {
      const config = await loadProfileConfig();
      const rows = Object.keys(config.profiles)
        .sort()
        .flatMap((name) => {
          const record = config.profiles[name];
          return record === undefined ? [] : [redactedView(record)];
        });
      respond(
        io,
        rows.length === 0
          ? { profiles: "0 profiles; commands target the local API" }
          : { default: config.defaultProfile ?? null, count: rows.length, profiles: rows },
        rows.length === 0
          ? [
              "Run `swizzle profile add <name> --url <api-url> --token-env SWIZZLE_TOKEN --env <environment>` to add one",
            ]
          : ["Run `swizzle whoami --profile <name>` to see who a profile acts as"],
      );
    });
  });

  const add = localCommand(
    profile
      .command("add")
      .description("Add or update a profile; the first one becomes the default")
      .argument("<name>", "Profile name, such as local or prod")
      .requiredOption("--url <url>", "Swizzle API base URL")
      .option(
        "--env <environment>",
        "Environment every command targets (overrides SWIZZLE_ENVIRONMENT)",
      )
      .option("--token <token>", "Inline token, stored in plaintext in ~/.swizzle/config.toml")
      .option("--token-env <var>", "Environment variable that holds the token at runtime")
      .option(
        "--project <project>",
        "Default project, by slug or id, for every command whose --project is optional",
      )
      .option("--default", "Make this the default profile"),
  );
  withExamples(add, [
    "swizzle profile add prod --url https://swizzle.example.com --token-env SWIZZLE_TOKEN --env prod",
    "swizzle profile add local --url http://api.localhost:19826 --env local --project billing --default",
  ]);
  add.action(async (name: string, options: ProfileAddOptions) => {
    await runHandler(async () => {
      if (options.token !== undefined && options.tokenEnv !== undefined) {
        throw new AgentError({
          code: "PROFILE_TOKEN_AMBIGUOUS",
          exitCode: EXIT_CODES.usage,
          hint: "Pass --token-env <var> to read the token at runtime, or --token <token> to store it.",
          message: "Use --token or --token-env, not both.",
        });
      }
      if (options.token !== undefined) assertBearerTokenFlag(options.token);
      const record: StoredProfile = {
        name,
        url: options.url,
        ...(options.env !== undefined ? { environment: options.env } : {}),
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(options.tokenEnv !== undefined ? { tokenEnv: options.tokenEnv } : {}),
        ...(options.project !== undefined ? { project: options.project } : {}),
      };
      const before = await loadProfileConfig();
      let config = upsertProfile(before, record);
      if (options.default === true || config.defaultProfile === undefined) {
        config = setDefaultProfile(config, name);
      }
      const previous = before.profiles[name];
      let state = "added";
      if (previous !== undefined) {
        const unchanged =
          JSON.stringify(sortedKeys(previous)) === JSON.stringify(sortedKeys(record)) &&
          before.defaultProfile === config.defaultProfile;
        state = unchanged ? "already saved (no-op)" : "updated";
      }
      const configPath = await saveProfileConfig(config);
      respond(
        io,
        {
          profile: redactedView(record),
          state,
          default: config.defaultProfile ?? null,
          configPath,
        },
        [
          `Run \`swizzle whoami --profile ${name}\` to check who it acts as`,
          ...(record.environment === undefined
            ? [`Pass -e <environment> on each command, or re-add with --env <environment>`]
            : []),
        ],
      );
    });
  });

  const use = localCommand(
    profile
      .command("use")
      .description("Make a profile the default")
      .argument("<name>", "Profile name"),
  );
  withExamples(use, ["swizzle profile use prod", "swizzle profile use local --json"]);
  use.action(async (name: string) => {
    await runHandler(async () => {
      const before = await loadProfileConfig();
      if (before.defaultProfile === name && before.profiles[name] !== undefined) {
        respond(io, { default: name, state: "already the default (no-op)" });
        return;
      }
      const configPath = await saveProfileConfig(setDefaultProfile(before, name));
      respond(io, { default: name, state: "set", configPath });
    });
  });

  const remove = localCommand(
    profile
      .command("remove")
      .description("Remove a profile; a missing one is a no-op")
      .argument("<name>", "Profile name"),
  );
  withExamples(remove, ["swizzle profile remove staging", "swizzle profile remove staging --json"]);
  remove.action(async (name: string) => {
    await runHandler(async () => {
      const before = await loadProfileConfig();
      if (before.profiles[name] === undefined) {
        respond(io, { profile: name, state: "already absent (no-op)" });
        return;
      }
      const config = removeProfile(before, name);
      const configPath = await saveProfileConfig(config);
      respond(io, {
        profile: name,
        state: "removed",
        default: config.defaultProfile ?? null,
        configPath,
      });
    });
  });

  registerWhoami(program, io, runHandler);
}

function sortedKeys(profile: StoredProfile): [string, unknown][] {
  return Object.entries(profile).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * `swizzle whoami`: the identity, project and environment the resolved profile acts as, and the
 * role that gives it there. It asks the API, so a revoked token or a suspended person shows here.
 */
function registerWhoami(program: Command, io: CliIO, runHandler: RunHandler): void {
  const whoami = program
    .command("whoami")
    .description("Show the identity, project, environment and role the profile acts as")
    .option("--project <project>", "Project, by slug or id (default: the profile's)");
  withExamples(whoami, ["swizzle whoami", "swizzle whoami --project billing -e prod --json"]);
  whoami.action(async (options: ApiCommandOptions & { project?: string }, command: Command) => {
    await runHandler(async () => {
      // The API URL main.ts settled, so the profile shown is the instance that answers.
      const profile = resolveProfile({
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
        ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
        config: await loadProfileConfig(),
      });
      const pinned = resolveEnvironment({
        ...(options.environment !== undefined ? { flag: options.environment } : {}),
        profileEnvironment: profile.environment,
        profileName: profile.name,
      });
      // A named profile without an environment shows as unpinned instead of failing.
      const environment = pinned.source === "unpinned" ? null : pinned.environment;
      const { environment: _flag, ...target } = options;
      const identity = await apiRequest<Identity>(
        buildApiUrl(
          "/auth/identity",
          environment === null ? target : { ...target, environment },
          options.project === undefined ? undefined : { project: options.project },
        ),
      );
      const source = projectSource(command);
      respond(
        io,
        {
          profile: `${profile.name} (${profile.source}) ${profile.url}`,
          identity: identityLabel(identity),
          ...(identity.token !== null ? { token: tokenLabel(identity.token, identity.kind) } : {}),
          project: options.project === undefined ? "none" : `${options.project} (from ${source})`,
          environment: environment === null ? "unpinned" : `${environment} (from ${pinned.source})`,
          ...(identity.target !== null
            ? {
                role:
                  identity.target.role ??
                  `none: project ${identity.target.project.reference} is out of reach`,
              }
            : {}),
        },
        [
          ...(options.project === undefined
            ? [
                "Pass --project <project>, or save one with `swizzle profile add <name> --url <url> --project <project>`, to see your role there",
              ]
            : []),
          ...(environment === null
            ? [
                "Pass -e <environment>, or save one with `swizzle profile add <name> --url <url> --env <environment>`",
              ]
            : []),
        ],
      );
    });
  });
}

/** Where whoami's project came from; main.ts fills an unpassed one from the profile as "config". */
function projectSource(command: Command): "flag" | "profile" | null {
  if (command.getOptionValue("project") === undefined) return null;
  if (command.getOptionValueSource("project") === "config") return "profile";
  return "flag";
}

function identityLabel(identity: Identity): string {
  if (identity.kind === "person" && identity.person !== null) {
    const { email, name, role } = identity.person;
    return `person ${name} <${email}>, instance role ${role}`;
  }
  if (identity.kind === "service-account" && identity.serviceAccount !== null) {
    const { name, project } = identity.serviceAccount;
    return `service account ${name} of project ${project.slug}`;
  }
  return `${identity.kind} that no longer exists`;
}

/**
 * A token's name, limits and expiry. A person's token without limits acts with all their rights,
 * which for an instance owner or admin reach past any project role, as the dashboard says.
 */
function tokenLabel(token: NonNullable<Identity["token"]>, holder: Identity["kind"]): string {
  const { environments, projects, role } = token.scope;
  const unlimited =
    holder === "person" && role === "admin" && projects === null && environments === null;
  const limits = unlimited
    ? ["all your rights"]
    : [
        `at most ${role}`,
        `projects ${projects === null ? "all" : projects.map((project) => project.slug).join(", ")}`,
        `environments ${environments === null ? "all" : environments.join(", ")}`,
      ];
  return [token.name, ...limits, `expires ${token.expiresAt}`].join("; ");
}
