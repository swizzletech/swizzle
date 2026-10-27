/**
 * `swizzle credential`: who may use and manage a secret or a connection, and which other projects
 * it is shared with. `access` lists every holder and the source of their right; `grant` and
 * `revoke` change a person's, team's or service account's right; `share`, `unshare`, `shares`,
 * `accept` and `decline` offer a credential to another project and take an offer in. The API
 * decides every step (apps/api/src/credential-routes.ts).
 */
import type { CredentialKind, CredentialRight } from "@swizzle/db";
import type {
  CredentialAccessResponse as CredentialAccessView,
  CredentialShareResponse,
  CredentialSharesResponse,
} from "@swizzle/runtime/http-contract";
import { Argument, type Command, Option } from "commander";

import { apiRequest } from "./api.js";
import {
  type ApiCommandOptions,
  buildApiUrl,
  type RunHandler,
  removeUnlessAbsent,
  showsSubcommands,
  withExamples,
} from "./command-support.js";
import { resolveCommandEnvironment } from "./environment-guard.js";
import { AgentError, type CliIO, EXIT_CODES, respond } from "./output.js";

type CredentialHolder = CredentialAccessView["holders"][number];
type CredentialRightSource = CredentialHolder["sources"][number];

/** `--project`: the project that owns the credential, by slug or id. */
interface ProjectOption {
  readonly project?: string;
}

/** Who a grant names: exactly one of them. */
interface SubjectOptions {
  readonly serviceAccount?: string;
  readonly team?: string;
  readonly user?: string;
}

type CommandOptions = ApiCommandOptions & ProjectOption;
type ReceivingOptions = ApiCommandOptions & { readonly project: string };

const kindArgument = () =>
  new Argument("<kind>", "secret or connection").choices(["secret", "connection"]);

export function registerCredentialCommands(
  program: Command,
  io: CliIO,
  runHandler: RunHandler,
): void {
  const credential = program
    .command("credential")
    .description(
      "Who may use and manage a secret or connection, and which projects it is shared with. A credential belongs to a project and an environment",
    );
  showsSubcommands(credential);
  withExamples(credential, [
    "swizzle credential access secret STRIPE_KEY --project billing",
    "swizzle credential grant secret STRIPE_KEY --team finance --right use --project billing",
  ]);

  /** One subcommand on a credential: `<kind> <name>` and --project, in the command's environment. */
  const onCredential = (name: string, description: string, examples: readonly [string, string]) => {
    const command = credential
      .command(name)
      .description(description)
      .addArgument(kindArgument())
      .argument("<name>", "Secret or connection name")
      .option(
        "--project <project>",
        "Project that owns it, by slug or id (default: the profile's)",
      );
    withExamples(command, examples);
    return command;
  };

  /** The URL of a route under /credentials/:kind/:name, in the command's environment and project. */
  const credentialUrl = async (
    kind: CredentialKind,
    name: string,
    options: CommandOptions,
    suffix: string,
    query: Record<string, string> = {},
  ) =>
    buildApiUrl(
      `/credentials/${kind}/${encodeURIComponent(name)}${suffix}`,
      { ...options, environment: await resolveCommandEnvironment(options) },
      { ...(options.project === undefined ? {} : { project: options.project }), ...query },
    );

  const readAccess = async (kind: CredentialKind, name: string, options: CommandOptions) =>
    await apiRequest<CredentialAccessView>(await credentialUrl(kind, name, options, "/access"));

  const projectFlag = (options: ProjectOption) =>
    options.project === undefined ? "" : ` --project ${options.project}`;

  onCredential(
    "access",
    "List everyone with a right on a credential and where it comes from, and its shares; needs use or manage",
    [
      "swizzle credential access secret STRIPE_KEY --project billing",
      "swizzle credential access connection google -e prod --json",
    ],
  ).action(async (kind: CredentialKind, name: string, options: CommandOptions) => {
    await runHandler(async () => {
      const access = await readAccess(kind, name, options);
      const { credential: stored } = access;
      respond(
        io,
        {
          credential: `${stored.kind} ${stored.name} in ${stored.environment}`,
          yourRight: access.right,
          holders: access.holders.map((holder) => ({
            name: holder.email === null ? holder.name : `${holder.name} <${holder.email}>`,
            kind: holder.subject.kind,
            right: holder.right,
            from: holder.sources.map(sourceLabel).join("; "),
          })),
          shares:
            access.shares.length === 0
              ? "none"
              : access.shares.map((share) => ({
                  project: share.project.name,
                  state: share.acceptedAt === null ? "offered" : `accepted ${share.acceptedAt}`,
                })),
        },
        access.right === "manage"
          ? [
              `Run \`swizzle credential grant ${kind} ${name} --team <team> --right use${projectFlag(options)}\` to let a team use it`,
              `Run \`swizzle credential share ${kind} ${name} --to <project>${projectFlag(options)}\` to offer it to another project`,
            ]
          : [],
      );
    });
  });

  withSubject(
    onCredential(
      "grant",
      "Give a person, team or service account use or manage on a credential; needs manage. A held right is a no-op",
      [
        "swizzle credential grant secret STRIPE_KEY --team finance --right use --project billing",
        "swizzle credential grant connection google --user ana@example.com --right manage --json",
      ],
    ).addOption(
      new Option("--right <right>", "use or manage")
        .choices(["use", "manage"])
        .makeOptionMandatory(),
    ),
  ).action(
    async (
      kind: CredentialKind,
      name: string,
      options: CommandOptions & SubjectOptions & { readonly right: CredentialRight },
    ) => {
      await runHandler(async () => {
        const subject = subjectOf(options);
        const shown = { credential: `${kind} ${name}`, subject: subjectLabel(subject) };
        const held = grantedRight(await readAccess(kind, name, options), subject);
        // Reading the access needs only use; the PUT is what the API holds to manage, so it runs
        // even for a grant that is already held.
        await apiRequest(await credentialUrl(kind, name, options, "/grants"), {
          body: JSON.stringify({ ...subject, right: options.right }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        });
        let state = `changed from ${held}`;
        if (held === undefined) state = "granted";
        else if (held === options.right) state = "already granted (no-op)";
        respond(io, { ...shown, right: options.right, state });
      });
    },
  );

  withSubject(
    onCredential(
      "revoke",
      "Remove the grant a person, team or service account holds on a credential; needs manage. A right by role or team stays; no grant is a no-op",
      [
        "swizzle credential revoke secret STRIPE_KEY --team finance --project billing",
        "swizzle credential revoke connection google --user ana@example.com --json",
      ],
    ),
  ).action(async (kind: CredentialKind, name: string, options: CommandOptions & SubjectOptions) => {
    await runHandler(async () => {
      const subject = subjectOf(options);
      const removed = await removeUnlessAbsent(
        "GRANT_NOT_FOUND",
        apiRequest(await credentialUrl(kind, name, options, "/grants", subject), {
          method: "DELETE",
        }),
      );
      respond(io, {
        credential: `${kind} ${name}`,
        subject: subjectLabel(subject),
        state: removed ? "revoked" : "not granted (no-op)",
      });
    });
  });

  onCredential(
    "share",
    "Offer a credential to another project; an admin there accepts it, at once when that is you. Needs manage",
    [
      "swizzle credential share secret STRIPE_KEY --to payroll --project billing",
      "swizzle credential share connection google --to ops -e prod --json",
    ],
  )
    .requiredOption("--to <project>", "Project to offer it to, by slug or id")
    .action(
      async (
        kind: CredentialKind,
        name: string,
        options: CommandOptions & { readonly to: string },
      ) => {
        await runHandler(async () => {
          const share = await apiRequest<CredentialShareResponse>(
            await credentialUrl(kind, name, options, `/shares/${encodeURIComponent(options.to)}`),
            { method: "PUT" },
          );
          const accepted = share.acceptedAt !== null;
          respond(
            io,
            {
              credential: `${kind} ${name}`,
              to: options.to,
              share: share.shareId,
              state: accepted ? "shared: its deployments may bind it" : "offered",
            },
            accepted
              ? []
              : [
                  `An admin of ${options.to} runs \`swizzle credential accept ${share.shareId} --project ${options.to}\``,
                ],
          );
        });
      },
    );

  onCredential(
    "unshare",
    "Withdraw a credential's offer or share to another project; its next injection there stops. Needs manage",
    [
      "swizzle credential unshare secret STRIPE_KEY --to payroll --project billing",
      "swizzle credential unshare connection google --to ops --json",
    ],
  )
    .requiredOption("--to <project>", "Project it is shared with, by slug or id")
    .action(
      async (
        kind: CredentialKind,
        name: string,
        options: CommandOptions & { readonly to: string },
      ) => {
        await runHandler(async () => {
          const removed = await removeUnlessAbsent(
            "SHARE_NOT_FOUND",
            apiRequest(
              await credentialUrl(kind, name, options, `/shares/${encodeURIComponent(options.to)}`),
              { method: "DELETE" },
            ),
          );
          respond(io, {
            credential: `${kind} ${name}`,
            to: options.to,
            state: removed ? "withdrawn" : "not shared (no-op)",
          });
        });
      },
    );

  /** The URL of a project's share route; a share holds in its credential's own environment. */
  const sharesUrl = (project: string, options: ApiCommandOptions, shareId?: string) =>
    buildApiUrl(
      `/projects/${encodeURIComponent(project)}/credential-shares${shareId === undefined ? "" : `/${encodeURIComponent(shareId)}`}`,
      options,
    );

  const shares = credential
    .command("shares")
    .description(
      "List the credentials other projects offer a project, accepted or not; for its admins",
    )
    .requiredOption("--project <project>", "Receiving project, by slug or id");
  withExamples(shares, [
    "swizzle credential shares --project payroll",
    "swizzle credential shares --project ops --json",
  ]);
  shares.action(async (options: ReceivingOptions) => {
    await runHandler(async () => {
      const { shares: offered } = await apiRequest<CredentialSharesResponse>(
        sharesUrl(options.project, options),
      );
      if (offered.length === 0) {
        respond(io, { shares: `0 credentials offered to ${options.project}` });
        return;
      }
      respond(
        io,
        {
          project: options.project,
          count: offered.length,
          shares: offered.map((share) => ({
            id: share.shareId,
            state: share.acceptedAt === null ? "offered" : "accepted",
            credential: `${share.credential.kind} ${share.credential.name}`,
            from: `${share.credentialProject.name} in ${share.credential.environment}`,
          })),
        },
        offered.some((share) => share.acceptedAt === null)
          ? [
              `Run \`swizzle credential accept <id> --project ${options.project}\` to take an offer in`,
            ]
          : [],
      );
    });
  });

  const onShare = (name: string, description: string, examples: readonly [string, string]) => {
    const command = credential
      .command(name)
      .description(description)
      .argument("<shareId>", "Share id, as `swizzle credential shares` lists it")
      .requiredOption("--project <project>", "Receiving project, by slug or id");
    withExamples(command, examples);
    return command;
  };

  onShare(
    "accept",
    "Accept an offered credential, so the project's deployments may bind it; for its admins",
    [
      "swizzle credential accept 7c1e… --project payroll",
      "swizzle credential accept 7c1e… --project ops --json",
    ],
  ).action(async (shareId: string, options: ReceivingOptions) => {
    await runHandler(async () => {
      const share = await apiRequest<CredentialShareResponse>(
        sharesUrl(options.project, options, shareId),
        { method: "PUT" },
      );
      respond(
        io,
        {
          share: share.shareId,
          credential: `${share.credential.kind} ${share.credential.name} in ${share.credential.environment}`,
          state: "accepted",
        },
        [
          `Run \`swizzle apply <dir> --project ${options.project} -e ${share.credential.environment}\` again to bind it`,
        ],
      );
    });
  });

  onShare(
    "decline",
    "Decline an offered credential, or end an accepted share; its next injection stops. For the project's admins",
    [
      "swizzle credential decline 7c1e… --project payroll",
      "swizzle credential decline 7c1e… --project ops --json",
    ],
  ).action(async (shareId: string, options: ReceivingOptions) => {
    await runHandler(async () => {
      const removed = await removeUnlessAbsent(
        "SHARE_NOT_FOUND",
        apiRequest(sharesUrl(options.project, options, shareId), { method: "DELETE" }),
      );
      respond(io, {
        share: shareId,
        project: options.project,
        state: removed ? "declined" : `no share ${shareId} offered to ${options.project} (no-op)`,
      });
    });
  });
}

/** The right a grant naming this subject itself gives, if one does. */
function grantedRight(
  access: CredentialAccessView,
  subject: Record<string, string>,
): CredentialRight | undefined {
  const holder = access.holders.find((candidate) => namesHolder(subject, candidate, access));
  return holder?.sources.find(
    (source): source is Extract<CredentialRightSource, { kind: "grant" }> =>
      source.kind === "grant",
  )?.right;
}

function namesHolder(
  subject: Record<string, string>,
  holder: CredentialHolder,
  access: CredentialAccessView,
): boolean {
  const s = holder.subject;
  if (subject.user !== undefined)
    return s.kind === "user" && (s.userId === subject.user || holder.email === subject.user);
  if (subject.team !== undefined)
    return s.kind === "team" && (s.teamId === subject.team || holder.name === subject.team);
  const account = access.serviceAccounts.find(
    (candidate) =>
      candidate.id === subject.serviceAccount || candidate.name === subject.serviceAccount,
  );
  return s.kind === "service-account" && account !== undefined && s.serviceAccountId === account.id;
}

function withSubject(command: Command): Command {
  return command
    .option("--user <user>", "Person, by id or email")
    .option("--team <team>", "Team, by id or name")
    .option(
      "--service-account <account>",
      "Service account of the credential's project, by id or name",
    );
}

/** The grant subject the options name, as the API takes it; a usage error unless exactly one. */
function subjectOf(options: SubjectOptions): Record<string, string> {
  const named = Object.entries({
    serviceAccount: options.serviceAccount,
    team: options.team,
    user: options.user,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined);
  const [only] = named;
  if (named.length !== 1 || only === undefined) {
    throw new AgentError({
      code: "SUBJECT_REQUIRED",
      exitCode: EXIT_CODES.usage,
      hint: "Name exactly one of --user, --team and --service-account.",
      message: "A grant names one person, team or service account.",
    });
  }
  return Object.fromEntries([only]);
}

function subjectLabel(subject: Record<string, string>): string {
  const [[key, value] = ["", ""]] = Object.entries(subject);
  return `${key === "serviceAccount" ? "service account" : key} ${value}`;
}

function sourceLabel(source: CredentialRightSource): string {
  if (source.kind === "role") {
    return source.role === "project-admin" ? "admin of its project" : `instance ${source.role}`;
  }
  return source.kind === "team"
    ? `${source.right} through team ${source.teamName}`
    : `${source.right} granted`;
}
