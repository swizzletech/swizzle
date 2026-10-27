/** `swizzle projects`: projects, their grants and protected environments; the command table is in access-commands.ts. */

import type {
  EnvironmentHold,
  ProjectRole,
  SetGrantBody,
  Subject,
  SubjectReference as SubjectRef,
} from "@swizzle/db";
import { PROJECT_ROLES, sameSubject } from "@swizzle/db";
import type {
  CreateProjectResponse as CreateProjectResult,
  DeleteProjectResponse,
  RemoveGrantResponse as GrantRemovalResult,
  SetGrantResponse as GrantWriteResult,
  ProjectAccessResponse as ProjectAccess,
  ProjectContentsResponse as ProjectContentCounts,
  ProjectsResponse,
  EnvironmentProtectionResponse as ProtectionResult,
} from "@swizzle/runtime/http-contract";
import { type Command, Option } from "commander";

import { apiRequest } from "./api.js";
import {
  type ApiCommandOptions,
  type RunHandler,
  buildAccessApiUrl as url,
  withExamples,
} from "./command-support.js";
import { AgentError, type CliIO, EXIT_CODES, respond } from "./output.js";

type ListedProject = ProjectsResponse["projects"][number];
type Grant = ProjectAccess["grants"][number];

const segment = encodeURIComponent;

/** Where a grant applies: the project, one environment, or one automation. */
type GrantPlaceRef =
  | { readonly on: "project" }
  | { readonly on: "environment"; readonly environment: string }
  | { readonly on: "automation"; readonly automation: string };

type SubjectOptions = {
  readonly user?: string;
  readonly team?: string;
  readonly serviceAccount?: string;
};

type PlaceOptions = { readonly onEnvironment?: string; readonly onAutomation?: string };

/** The one subject `--user`, `--team` or `--service-account` names; none or several is a usage error. */
function subjectFromOptions(options: SubjectOptions): SubjectRef {
  const given = [
    ...(options.user !== undefined ? [{ user: options.user }] : []),
    ...(options.team !== undefined ? [{ team: options.team }] : []),
    ...(options.serviceAccount !== undefined ? [{ serviceAccount: options.serviceAccount }] : []),
  ];
  const [subject] = given;
  if (given.length !== 1 || subject === undefined) {
    throw new AgentError({
      code: "SUBJECT_REQUIRED",
      exitCode: EXIT_CODES.usage,
      hint: "Pass exactly one of --user <email>, --team <name> or --service-account <name>.",
      message:
        given.length === 0 ? "No subject given." : "Several subjects given; a grant names one.",
    });
  }
  return subject;
}

/** `--on-environment` or `--on-automation`, never both; neither is the whole project. */
function placeFromOptions(options: PlaceOptions): GrantPlaceRef {
  if (options.onEnvironment !== undefined && options.onAutomation !== undefined) {
    throw new AgentError({
      code: "GRANT_PLACE_CONFLICT",
      exitCode: EXIT_CODES.usage,
      hint: "Pass --on-environment or --on-automation, or neither for the whole project.",
      message: "A grant applies to an environment or an automation, not both.",
    });
  }
  if (options.onEnvironment !== undefined) {
    return { environment: options.onEnvironment, on: "environment" };
  }
  if (options.onAutomation !== undefined) {
    return { automation: options.onAutomation, on: "automation" };
  }
  return { on: "project" };
}

function subjectOptions(command: Command): Command {
  return command
    .option("--user <person>", "A person, by email or id")
    .option("--team <team>", "A team, by name or id")
    .option("--service-account <account>", "One of the project's service accounts, by name or id");
}

function placeOptions(command: Command): Command {
  return command
    .option("--on-environment <environment>", "Only in this environment of the project")
    .option("--on-automation <automation>", "Only on this automation of the project");
}

interface DeleteProjectOptions extends ApiCommandOptions {
  readonly deleteContents?: boolean;
  readonly moveTo?: string;
  readonly yes?: boolean;
}

/** "2 automations, 1 credential, 40 runs", or null for an empty project. */
function contentsText(counts: ProjectContentCounts): string | null {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${count === 1 ? kind.slice(0, -1) : kind}`);
  return parts.length === 0 ? null : parts.join(", ");
}

function contentsOutcome(
  contents: "delete" | "move" | "empty",
  held: string | null,
  moveTo: string | undefined,
): string {
  if (contents === "move") return `${held ?? "nothing"} moved to ${moveTo}`;
  if (contents === "delete") return `${held ?? "nothing"} deleted`;
  return "none";
}

async function listProjects(options: ApiCommandOptions): Promise<readonly ListedProject[]> {
  return (await apiRequest<ProjectsResponse>(url("/projects", options))).projects;
}

export function registerProjects(program: Command, io: CliIO, runHandler: RunHandler): void {
  const projects = program
    .command("projects")
    .description(
      "List projects and manage who may do what in them (owners, admins, project admins)",
    );
  withExamples(projects, [
    "swizzle projects",
    "swizzle projects grant billing --user anna@example.com --role operator --on-environment staging",
  ]);

  const list = projects
    .command("list", { isDefault: true })
    .description("List the projects you can see, with your role in each");
  withExamples(list, ["swizzle projects list", "swizzle projects list --json"]);
  list.action(async (options: ApiCommandOptions) => {
    await runHandler(async () => {
      const rows = (await listProjects(options)).map((project) => ({
        slug: project.slug,
        name: project.name,
        role: project.role,
        protected: project.protectedEnvironments.join(" ") || "none",
      }));
      if (rows.length === 0) {
        respond(io, { projects: "0 projects you can see" }, [
          "No project grants you a role; an instance owner or admin adds you",
        ]);
        return;
      }
      respond(io, { count: rows.length, projects: rows }, [
        "Run `swizzle projects access <slug>` for who holds which role in one",
      ]);
    });
  });

  const create = projects
    .command("create")
    .description("Create a project (instance owners and admins); an existing slug is a no-op")
    .argument("<slug>", "URL name of the project, such as billing")
    .requiredOption("--name <name>", "Display name");
  withExamples(create, [
    "swizzle projects create billing --name Billing",
    'swizzle projects create office-ops --name "Office operations" --json',
  ]);
  create.action(async (slug: string, options: ApiCommandOptions & { readonly name: string }) => {
    await runHandler(async () => {
      const created = await apiRequest<CreateProjectResult>(url("/projects", options), {
        body: JSON.stringify({ name: options.name, slug }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      respond(
        io,
        {
          project: { slug: created.slug, name: created.name },
          state: created.changed ? "created" : "already exists (no-op)",
        },
        [
          `Run \`swizzle projects grant ${created.slug} --team <team> --role editor\` to let a team build in it`,
          `Run \`swizzle apply <dir> --project ${created.slug}\` to deploy an automation into it`,
        ],
      );
    });
  });

  const remove = projects
    .command("delete")
    .description(
      "Delete a project (its admins). What it holds moves to another project with --move-to or goes with it with --delete-contents; audit events stay. A missing one is a no-op",
    )
    .argument("<project>", "Project slug or id")
    .addOption(
      new Option(
        "--move-to <project>",
        "Move its automations, credentials and runs to this project, which you also administer",
      ).conflicts("deleteContents"),
    )
    .addOption(
      new Option("--delete-contents", "Delete its automations, credentials and runs with it"),
    )
    .option("--yes", "Confirm the delete (required)");
  withExamples(remove, [
    "swizzle projects delete old-experiments --move-to default --yes",
    "swizzle projects delete old-experiments --delete-contents --yes --json",
  ]);
  remove.action(async (reference: string, options: DeleteProjectOptions) => {
    await runHandler(async () => {
      const query: Record<string, string> = { confirm: String(options.yes === true) };
      if (options.moveTo !== undefined) {
        query.contents = "move";
        query.to = options.moveTo;
      } else if (options.deleteContents === true) query.contents = "delete";
      let result: DeleteProjectResponse;
      try {
        result = await apiRequest<DeleteProjectResponse>(
          url(`/projects/${segment(reference)}`, options, query),
          { method: "DELETE" },
        );
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== "PROJECT_NOT_FOUND") throw error;
        respond(io, { project: reference, state: "absent or not visible to you (no-op)" });
        return;
      }
      if (!result.changed) {
        respond(io, { project: result.project, state: "absent or not visible to you (no-op)" });
        return;
      }
      respond(io, {
        project: result.project,
        state: "deleted",
        contents: contentsOutcome(result.contents, contentsText(result.counts), options.moveTo),
      });
    });
  });

  const access = projects
    .command("access")
    .description(
      "Show who reaches a project and with which role, overall and per environment, and its grants",
    )
    .argument("<project>", "Project slug or id");
  withExamples(access, [
    "swizzle projects access billing",
    "swizzle projects access billing --json",
  ]);
  access.action(async (reference: string, options: ApiCommandOptions) => {
    await runHandler(async () => {
      const state = await projectAccess(reference, options);
      const names = subjectNames(state);
      respond(
        io,
        {
          project: state.project.slug,
          protected: state.protectedEnvironments.join(" ") || "none",
          holders: state.holders.map((holder) => ({
            name: holder.email ?? holder.name,
            kind: holder.subject.kind,
            role: holder.role ?? "none",
            environments: Object.entries(holder.environments)
              .map(
                ([environment, hold]) => `${environment}=${holdLabel(hold, holder.subject.kind)}`,
              )
              .join(" "),
          })),
          grants:
            state.grants.length === 0
              ? "none"
              : state.grants.map((grant) => ({
                  subject: names(grant.subject),
                  on: placeLabel(grant, state),
                  role: grant.role,
                })),
        },
        [
          `Run \`swizzle projects grant ${state.project.slug} --user <email> --role <role>\` to add one`,
          `Run \`swizzle projects revoke ${state.project.slug} --user <email>\` to remove one`,
        ],
      );
    });
  });

  const grant = placeOptions(
    subjectOptions(
      projects
        .command("grant")
        .description(
          "Give a person, team or service account a role in a project, or in one protected environment or automation of it; a held grant is a no-op",
        )
        .argument("<project>", "Project slug or id"),
    ),
  ).addOption(
    new Option(
      "--role <role>",
      "viewer reads, operator runs, editor deploys, admin manages access (admin only on the whole project)",
    )
      .choices(PROJECT_ROLES)
      .makeOptionMandatory(),
  );
  withExamples(grant, [
    "swizzle projects grant billing --team Developers --role editor",
    "swizzle projects grant billing --user anna@example.com --role operator --on-environment production",
    "swizzle projects grant billing --service-account ci --role editor --on-automation invoice-sync",
  ]);
  grant.action(
    async (
      reference: string,
      options: ApiCommandOptions & SubjectOptions & PlaceOptions & { readonly role: ProjectRole },
    ) => {
      await runHandler(async () => {
        const subjectRef = subjectFromOptions(options);
        const place = placeFromOptions(options);
        const body = {
          ...subjectRef,
          ...placeBody(place),
          role: options.role,
        } satisfies SetGrantBody;
        const result = await apiRequest<GrantWriteResult>(
          url(`/projects/${segment(reference)}/grants`, options),
          {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
            method: "PUT",
          },
        );
        let state = "granted";
        if (result.previousRole === result.role) state = "already held (no-op)";
        else if (result.previousRole !== null) state = `changed from ${result.previousRole}`;
        respond(io, {
          grant: {
            project: result.project,
            subject: result.subject,
            on: placeRefLabel(place),
            role: result.role,
          },
          state,
        });
      });
    },
  );

  const revoke = placeOptions(
    subjectOptions(
      projects
        .command("revoke")
        .description("Remove a grant from a project; a grant that does not exist is a no-op")
        .argument("<project>", "Project slug or id"),
    ),
  );
  withExamples(revoke, [
    "swizzle projects revoke billing --team Developers",
    "swizzle projects revoke billing --user anna@example.com --on-environment production",
  ]);
  revoke.action(
    async (reference: string, options: ApiCommandOptions & SubjectOptions & PlaceOptions) => {
      await runHandler(async () => {
        const subjectRef = subjectFromOptions(options);
        const place = placeFromOptions(options);
        const result = await apiRequest<GrantRemovalResult>(
          url(`/projects/${segment(reference)}/grants`, options, {
            ...subjectRef,
            ...placeBody(place),
          }),
          { method: "DELETE" },
        );
        respond(io, {
          grant: { project: result.project, subject: result.subject, on: placeRefLabel(place) },
          state: result.changed ? "revoked" : "not held (no-op)",
        });
      });
    },
  );

  for (const protect of [true, false]) {
    const name = protect ? "protect" : "unprotect";
    const command = projects
      .command(name)
      .description(
        protect
          ? "Protect an environment of a project: only grants on that environment reach it; already protected is a no-op"
          : "Lift an environment's protection and remove its environment grants, so project grants reach it again; unprotected is a no-op",
      )
      .argument("<project>", "Project slug or id")
      .argument("<environment>", "Environment name");
    if (!protect)
      command.option(
        "--yes",
        "Confirm removal of protection and its environment grants (required)",
      );
    withExamples(command, [
      `swizzle projects ${name} billing production${protect ? "" : " --yes"}`,
      `swizzle projects ${name} billing staging${protect ? "" : " --yes"} --json`,
    ]);
    command.action(
      async (
        reference: string,
        environment: string,
        options: ApiCommandOptions & { readonly yes?: boolean },
      ) => {
        await runHandler(async () => {
          const result = await apiRequest<ProtectionResult>(
            url(
              `/projects/${segment(reference)}/environments/${segment(environment)}/protection`,
              options,
              protect ? undefined : { confirm: String(options.yes === true) },
            ),
            { method: protect ? "PUT" : "DELETE" },
          );
          let state: string;
          if (protect) state = result.changed ? "protected" : "already protected (no-op)";
          else state = result.changed ? "unprotected" : "already unprotected (no-op)";
          respond(
            io,
            {
              project: result.project,
              environment: result.environment,
              state,
              ...(!protect && result.changed ? { grantsRemoved: result.grantsRemoved } : {}),
            },
            protect && result.changed
              ? [
                  `Run \`swizzle projects grant ${result.project} --team <team> --role editor --on-environment ${environment}\` to let a team deploy there`,
                ]
              : [],
          );
        });
      },
    );
  }
}

async function projectAccess(
  reference: string,
  options: ApiCommandOptions,
): Promise<ProjectAccess> {
  return await apiRequest<ProjectAccess>(url(`/projects/${segment(reference)}/access`, options));
}

/**
 * What a holder may do in one environment. A team acts only through its members, so in a
 * protected environment it shows the role its grant there caps them at.
 */
function holdLabel(hold: EnvironmentHold, kind: Subject["kind"]): string {
  if (kind === "team" && hold.cap !== null) return `${hold.cap} (grant)`;
  return hold.role ?? "none";
}

/** Labels for grant subjects: a person's email, a team's or a service account's name. */
function subjectNames(state: ProjectAccess): (subject: Subject) => string {
  return (subject) => {
    const holder = state.holders.find((candidate) => sameSubject(candidate.subject, subject));
    if (holder !== undefined) return holder.email ?? holder.name;
    if (subject.kind === "team") return subject.teamId;
    return subject.kind === "user" ? subject.userId : subject.serviceAccountId;
  };
}

function placeLabel(grant: Grant, state: ProjectAccess): string {
  if (grant.on === "project") return "project";
  if (grant.on === "environment") return `environment ${grant.environment}`;
  return `automation ${state.automationSlugs[grant.automationId] ?? grant.automationId}`;
}

function placeRefLabel(place: GrantPlaceRef): string {
  if (place.on === "project") return "project";
  if (place.on === "environment") return `environment ${place.environment}`;
  return `automation ${place.automation}`;
}

function placeBody(place: GrantPlaceRef): Record<string, string> {
  if (place.on === "environment") return { environment: place.environment };
  if (place.on === "automation") return { automation: place.automation };
  return {};
}
