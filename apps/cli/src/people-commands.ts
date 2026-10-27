/** `swizzle people`: the instance's people, invitations and reset links; the command table is in access-commands.ts. */

import type { InstanceRole, ProjectRole } from "@swizzle/db";
import { INSTANCE_ROLES, PROJECT_ROLES } from "@swizzle/db";
import type {
  PeopleResponse,
  ResetLinkResponse,
  SentInvitationResponse,
} from "@swizzle/runtime/http-contract";
import { type Command, InvalidArgumentError, Option } from "commander";

import { apiRequest } from "./api.js";
import {
  type ApiCommandOptions,
  addFieldsOption,
  type FieldsCommandOptions,
  type RunHandler,
  buildAccessApiUrl as url,
  withExamples,
} from "./command-support.js";
import { AgentError, type CliIO, EXIT_CODES, respond, selectFields } from "./output.js";

type Person = PeopleResponse["users"][number];

const segment = encodeURIComponent;

export async function listPeople(options: ApiCommandOptions): Promise<readonly Person[]> {
  return (await apiRequest<PeopleResponse>(url("/users", options))).users;
}

async function findPerson(reference: string, options: ApiCommandOptions): Promise<Person> {
  const person = (await listPeople(options)).find(
    (candidate) =>
      candidate.id === reference || candidate.email.toLowerCase() === reference.toLowerCase(),
  );
  if (person === undefined) {
    throw new AgentError({
      code: "USER_NOT_FOUND",
      exitCode: EXIT_CODES.notFound,
      fixCommand: "swizzle people",
      message: `No person ${reference} on this instance.`,
    });
  }
  return person;
}

const PEOPLE_FIELDS = ["email", "name", "role"] as const;

export function registerPeople(program: Command, io: CliIO, runHandler: RunHandler): void {
  const people = program
    .command("people")
    .description(
      "List the people of this instance, invite one, or hand one a password reset link (owners, admins); suspend them in the dashboard",
    );
  withExamples(people, [
    "swizzle people",
    "swizzle people invite anna@example.com --role member --project billing=editor",
    "swizzle people reset-link anna@example.com",
  ]);

  const list = addFieldsOption(
    people
      .command("list", { isDefault: true })
      .description("List the people of this instance with their instance role (owners and admins)"),
    [...PEOPLE_FIELDS],
  );
  withExamples(list, [
    "swizzle people list",
    "swizzle people list --fields suspended,twoFactor,id",
  ]);
  list.action(async (options: ApiCommandOptions & FieldsCommandOptions) => {
    await runHandler(async () => {
      const rows = selectFields(
        (await listPeople(options)).map((person) => ({
          email: person.email,
          id: person.id,
          name: person.name,
          role: person.role,
          suspended: person.suspended,
          twoFactor: person.twoFactorEnabled,
        })),
        PEOPLE_FIELDS,
        options.fields,
      );
      respond(io, { count: rows.length, people: rows }, [
        "Run `swizzle teams add <team> <email>` to add one to a team",
      ]);
    });
  });

  const invite = people
    .command("invite")
    .description(
      "Invite a person and print the link that creates their account, shown once; with a mail server it is also mailed",
    )
    .argument("<email>", "The person's email address")
    .addOption(
      new Option(
        "--role <role>",
        "member sees only granted projects, admin manages the instance, owner also manages owners",
      )
        .choices(INSTANCE_ROLES)
        .makeOptionMandatory(),
    )
    .option(
      "--project <project=role>",
      "A project a member gets, by slug or id, with its role (viewer, operator, editor, admin); repeat for more",
      (value: string, previous: readonly ProjectInvite[]) => [...previous, projectInvite(value)],
      [] as readonly ProjectInvite[],
    );
  withExamples(invite, [
    "swizzle people invite anna@example.com --role member --project billing=editor",
    "swizzle people invite bert@example.com --role admin --json",
  ]);
  invite.action(
    async (
      email: string,
      options: ApiCommandOptions & {
        readonly role: InstanceRole;
        readonly project: readonly ProjectInvite[];
      },
    ) => {
      await runHandler(async () => {
        const sent = await apiRequest<SentInvitationResponse>(url("/invitations", options), {
          body: JSON.stringify({
            email: email.trim(),
            projects: options.project,
            role: options.role,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        respond(io, {
          invitation: {
            email: sent.email,
            role: sent.role,
            projects:
              sent.grants.map((grant) => `${grant.project.slug}=${grant.role}`).join(" ") || "none",
          },
          link: sent.url,
          expiresAt: sent.expiresAt,
          mailed: sent.mailed,
          note: sent.mailed
            ? "Mailed to them as well. The link creates one account for this address and is shown only now."
            : "Send it to them yourself; this instance sends no mail. It creates one account for this address and is shown only now.",
        });
      });
    },
  );

  const resetLink = people
    .command("reset-link")
    .description(
      "Make a link that sets a person's new password once, within the hour; it is shown once and works without mail",
    )
    .argument("<person>", "Email or user id");
  withExamples(resetLink, [
    "swizzle people reset-link anna@example.com",
    "swizzle people reset-link anna@example.com --json",
  ]);
  resetLink.action(async (reference: string, options: ApiCommandOptions) => {
    await runHandler(async () => {
      const person = await findPerson(reference.trim(), options);
      const link = await apiRequest<ResetLinkResponse>(
        url(`/users/${segment(person.id)}/reset-link`, options),
        { method: "POST" },
      );
      respond(io, {
        person: person.email,
        resetLink: link.url,
        expiresAt: link.expiresAt,
        note: "Send it to them yourself; it works once and is shown only now. Using it signs them out everywhere and revokes their agent tokens.",
      });
    });
  });
}

type ProjectInvite = { readonly project: string; readonly role: ProjectRole };

/** `billing=editor` from `--project`; a missing or unknown role is a usage error. */
function projectInvite(value: string): ProjectInvite {
  const at = value.lastIndexOf("=");
  const project = value.slice(0, Math.max(at, 0)).trim();
  const role = PROJECT_ROLES.find((candidate) => candidate === value.slice(at + 1).trim());
  if (project.length === 0 || role === undefined) {
    throw new InvalidArgumentError(
      `Expected <project>=<role>, such as billing=editor, with a role of ${PROJECT_ROLES.join(", ")}.`,
    );
  }
  return { project, role };
}
