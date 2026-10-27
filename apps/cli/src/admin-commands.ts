/**
 * Operating an instance: `status` and `doctor` read its health, `secret` manages write-only
 * secrets, `timeout-grant` raises one automation's run-timeout ceiling, and `notify` manages
 * Telegram notification rules. `doctor` exits 1 when a check fails.
 */
import { formatRuntimeTimeoutMs, parseRuntimeTimeout } from "@swizzle/runtime";
import type {
  AutomationsResponse,
  ConnectionsResponse,
  HealthResponse,
  NotificationDeliveriesResponse,
  NotificationRuleResponse as NotificationRuleRecord,
  NotificationRulesResponse,
  OperationsSummaryResponse as OperationsSummary,
  ReadyResponse,
  SecretResponse as SecretMetadata,
  SecretsResponse,
  SetSecretResponse,
  SetTimeoutGrantResponse,
  TimeoutGrantResponse,
  TimeoutGrantsResponse,
} from "@swizzle/runtime/http-contract";
import { type Command, Option } from "commander";

import { apiRequest } from "./api.js";
import { resolveAutomationNameOrDie } from "./automation-api.js";
import {
  type ApiCommandOptions,
  buildApiUrl,
  DEFAULT_API_URL,
  type ExactCommandOptions,
  type PaginationCommandOptions,
  parseCount,
  type RunHandler,
  removeUnlessAbsent,
  requireYes,
  withExamples,
} from "./command-support.js";
import { buildUnservedEnvironmentWarning, resolveCommandEnvironment } from "./environment-guard.js";
import { AgentError, type CliIO, EXIT_CODES, HandledCliError, respond, warn } from "./output.js";
import { VERSION } from "./version.js";

type TimeoutGrantRecord = NonNullable<TimeoutGrantResponse["grant"]>;

interface ProjectOption {
  readonly project?: string;
}

const projectFlag = (options: ProjectOption) =>
  options.project === undefined ? "" : ` --project ${options.project}`;

/** The command's options with its environment settled: the flag, the profile, or the default. */
async function inEnvironment<T extends ApiCommandOptions>(
  options: T,
): Promise<T & { readonly environment: string }> {
  return { ...options, environment: await resolveCommandEnvironment(options) };
}

/** The routes that take no environment, such as one notification rule by id. */
function instanceUrl(pathname: string, options: ApiCommandOptions): string {
  const { environment: _environment, ...target } = options;
  return buildApiUrl(pathname, target);
}

export function registerAdminCommands(program: Command, io: CliIO, runHandler: RunHandler): void {
  registerStatus(program, io, runHandler);
  registerDoctor(program, io, runHandler);
  registerSecret(program, io, runHandler);
  registerTimeoutGrant(program, io, runHandler);
  registerNotify(program, io, runHandler);
}

function registerStatus(program: Command, io: CliIO, runHandler: RunHandler): void {
  const status = program
    .command("status")
    .description("Show the environment's health: state, queue, notifications and maintenance");
  withExamples(status, ["swizzle status", "swizzle status -e prod --json"]);
  status.action(async (inputOptions: ApiCommandOptions) => {
    await runHandler(async () => {
      const options = {
        ...inputOptions,
        environment: await resolveCommandEnvironment(inputOptions, (environment, environments) => {
          const unserved = buildUnservedEnvironmentWarning({
            mode: "status",
            environment,
            environments,
          });
          if (unserved !== null) warn(unserved);
        }),
      };
      const summary = await apiRequest<OperationsSummary>(buildApiUrl("/ops/summary", options));
      respond(
        io,
        {
          environment: summary.environment,
          state: summary.state,
          ...(summary.stateReasons.length > 0 ? { reasons: summary.stateReasons } : {}),
          queue: `${summary.queue.counts.waiting} waiting, ${summary.queue.counts.failed} failed`,
          notifications: `${summary.notifications.sent} sent, ${summary.notifications.failed} failed`,
          maintenance: summary.maintenance.state,
        },
        summary.state === "healthy"
          ? []
          : ["Run `swizzle doctor` to check the API, database, queue and stores one by one"],
      );
    });
  });
}

interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly hint?: string;
  readonly fixCommand?: string;
}

// Preflight: verifies the things that break a first run (API reachable, platform ready, auth
// accepted, encryption key present) before the agent burns a deploy and trigger cycle on them.
function registerDoctor(program: Command, io: CliIO, runHandler: RunHandler): void {
  const doctor = program
    .command("doctor")
    .description(
      "Preflight check: API reachable, platform ready, auth valid, secret and connection stores usable; exits 1 on a failure",
    );
  withExamples(doctor, ["swizzle doctor", "swizzle doctor --profile prod --json"]);
  doctor.action(async (inputOptions: ApiCommandOptions) => {
    await runHandler(async () => {
      let options: ApiCommandOptions = inputOptions;
      const checks: DoctorCheck[] = [];
      // Doctor keeps testing the instance when environment discovery fails.
      try {
        options = await inEnvironment(inputOptions);
      } catch (error) {
        if (
          !(error instanceof AgentError) ||
          error.code === "ENVIRONMENT_NOT_PINNED" ||
          error.code.startsWith("PROFILE_")
        )
          throw error;
        checks.push({ name: "environment", ok: false, detail: `${error.code}: ${error.message}` });
      }
      let serverVersion: string | null = null;

      checks.push(
        await runDoctorCheck("api", "API reachable", async () => {
          const health = await apiRequest<HealthResponse>(buildApiUrl("/health", options));
          serverVersion = health.version ?? null;
        }),
        await runDoctorCheck("ready", "platform ready (database, queue, artifact storage)", () =>
          apiRequest<ReadyResponse>(buildApiUrl("/ready", options)),
        ),
        await runDoctorCheck("auth", "auth accepted by the control plane", () =>
          apiRequest<AutomationsResponse>(buildApiUrl("/dashboard/automations", options)),
        ),
        await runDoctorCheck("secrets", "secret store usable (encryption key configured)", () =>
          apiRequest<SecretsResponse>(buildApiUrl("/secrets", options)),
        ),
        await runDoctorCheck("connections", "connection store usable", () =>
          apiRequest<ConnectionsResponse>(buildApiUrl("/connections", options)),
        ),
      );

      const failed = checks.filter((check) => !check.ok);
      respond(
        io,
        {
          result:
            failed.length === 0
              ? "all checks passed"
              : `${failed.length} of ${checks.length} checks failed`,
          api: options.apiUrl ?? DEFAULT_API_URL,
          environment: options.environment ?? null,
          cliVersion: VERSION,
          serverVersion,
          checks: checks.map((check) => ({
            name: check.name,
            status: check.ok ? "pass" : "fail",
            detail: check.detail,
          })),
        },
        failed.flatMap((check) => [
          ...(check.fixCommand !== undefined
            ? [`Run \`${check.fixCommand}\` (${check.name})`]
            : []),
          ...(check.hint !== undefined ? [`${check.name}: ${check.hint}`] : []),
        ]),
      );
      if (failed.length > 0) throw new HandledCliError(EXIT_CODES.generic);
    });
  });
}

async function runDoctorCheck(
  name: string,
  description: string,
  probe: () => Promise<unknown>,
): Promise<DoctorCheck> {
  try {
    await probe();
    return { detail: description, name, ok: true };
  } catch (error) {
    if (error instanceof AgentError) {
      return {
        detail: `${error.code}: ${error.message}`,
        name,
        ok: false,
        ...(error.hint !== undefined ? { hint: error.hint } : {}),
        ...(error.fixCommand !== undefined ? { fixCommand: error.fixCommand } : {}),
      };
    }
    return { detail: error instanceof Error ? error.message : String(error), name, ok: false };
  }
}

// ---------- secret ----------

function registerSecret(program: Command, io: CliIO, runHandler: RunHandler): void {
  const secret = program
    .command("secret")
    .description(
      "Manage write-only secrets. A secret belongs to a project and an environment; values never leave the API",
    );
  withExamples(secret, [
    "swizzle secret",
    "swizzle secret set STRIPE_KEY --value-env STRIPE_KEY --project billing",
  ]);
  const PROJECT_OPTION = [
    "--project <project>",
    "Project, by slug or id (default: the profile's, else Default)",
  ] as const;
  const inProject = (options: ProjectOption) =>
    options.project === undefined ? undefined : { project: options.project };

  const list = secret
    .command("list", { isDefault: true })
    .description("List an environment's secrets, of one project or every project you may read")
    .option("--project <project>", "Project, by slug or id (default: every project you may read)");
  withExamples(list, [
    "swizzle secret list",
    "swizzle secret list --project billing -e prod --json",
  ]);
  list.action(async (inputOptions: ApiCommandOptions & ProjectOption) => {
    await runHandler(async () => {
      const options = await inEnvironment(inputOptions);
      const response = await apiRequest<SecretsResponse>(
        buildApiUrl("/secrets", options, inProject(options)),
      );
      if (response.secrets.length === 0) {
        respond(io, { secrets: `0 secrets in ${response.environment}` }, [
          `Run \`swizzle secret set <name> --value-env <VAR>${projectFlag(options)}\` to add one`,
        ]);
        return;
      }
      respond(io, {
        environment: response.environment,
        count: response.secrets.length,
        // A list can span projects, and names are unique only within one.
        secrets: response.secrets.map((entry) => ({
          name: entry.name,
          project: entry.project.slug,
          version: entry.secretVersion,
          updatedAt: entry.updatedAt,
        })),
      });
    });
  });

  const inspect = secret
    .command("inspect")
    .description("Show a secret's metadata; its value never leaves the API")
    .argument("<name>", "Secret name")
    .option(...PROJECT_OPTION);
  withExamples(inspect, [
    "swizzle secret inspect STRIPE_KEY",
    "swizzle secret inspect STRIPE_KEY --project billing --json",
  ]);
  inspect.action(async (name: string, inputOptions: ApiCommandOptions & ProjectOption) => {
    await runHandler(async () => {
      const options = await inEnvironment(inputOptions);
      const metadata = await apiRequest<SecretMetadata>(
        buildApiUrl(`/secrets/${encodeURIComponent(name)}`, options, inProject(options)),
      );
      respond(io, {
        secret: {
          name: metadata.name,
          environment: metadata.environment,
          project: metadata.project.slug,
          version: metadata.secretVersion,
          algorithm: metadata.algorithm,
          keyVersion: metadata.keyVersion,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
        },
      });
    });
  });

  const set = secret
    .command("set")
    .description(
      "Create a secret; replacing an existing one needs --overwrite, since the old value is gone for good",
    )
    .argument("<name>", "Secret name")
    .option(
      "--value-env <var>",
      "Read the value from this environment variable (keeps it out of argv)",
    )
    .option("-v, --value <value>", "The value itself; it lands in shell history and process lists")
    .option("--overwrite", "Replace an existing secret")
    .option(...PROJECT_OPTION);
  withExamples(set, [
    "swizzle secret set STRIPE_KEY --value-env STRIPE_KEY --project billing",
    "swizzle secret set STRIPE_KEY --value-env STRIPE_KEY --overwrite -e prod --json",
  ]);
  set.action(
    async (
      name: string,
      inputOptions: ApiCommandOptions &
        ProjectOption & {
          readonly value?: string;
          readonly valueEnv?: string;
          readonly overwrite?: boolean;
        },
    ) => {
      await runHandler(async () => {
        if ((inputOptions.value === undefined) === (inputOptions.valueEnv === undefined)) {
          throw new AgentError({
            code: "SECRET_VALUE_SOURCE_REQUIRED",
            exitCode: EXIT_CODES.usage,
            fixCommand: `swizzle secret set ${name} --value-env <VAR>`,
            hint: "Pass exactly one of --value-env and --value; --value-env keeps the value out of process arguments.",
            message:
              inputOptions.value === undefined
                ? "No secret value given."
                : "--value and --value-env cannot be used together.",
          });
        }
        const value =
          inputOptions.valueEnv === undefined
            ? inputOptions.value
            : process.env[inputOptions.valueEnv.trim()];
        if (inputOptions.valueEnv !== undefined && (value === undefined || value.length === 0)) {
          throw new AgentError({
            code: "SECRET_VALUE_ENV_MISSING",
            exitCode: EXIT_CODES.validation,
            hint: `Export ${inputOptions.valueEnv} with the value, then run the command again.`,
            message: `Environment variable ${inputOptions.valueEnv} is missing or empty.`,
          });
        }
        const options = await inEnvironment(inputOptions);
        // One atomic PUT; the server checks for an existing row under a lock. Without
        // --overwrite the CLI asks for create-only, so an existing secret answers 409
        // SECRET_ALREADY_EXISTS instead of being replaced.
        const response = await apiRequest<SetSecretResponse>(
          buildApiUrl(`/secrets/${encodeURIComponent(name)}`, options, {
            ...inProject(options),
            overwrite: options.overwrite === true ? "true" : "false",
          }),
          {
            body: JSON.stringify({ value }),
            headers: { "content-type": "application/json" },
            method: "PUT",
          },
        );
        for (const message of response.warnings ?? []) warn(message);
        respond(io, {
          secret: {
            name: response.name,
            environment: response.environment,
            version: response.secretVersion,
            state:
              response.secretVersion > 1
                ? "replaced; the previous value is not recoverable"
                : "created",
          },
        });
      });
    },
  );

  const remove = secret
    .command("delete")
    .description("Delete a secret for good; a missing one is a no-op")
    .argument("<name>", "Secret name")
    .option("--yes", "Confirm the delete (required)")
    .option(...PROJECT_OPTION);
  withExamples(remove, [
    "swizzle secret delete STRIPE_KEY --yes",
    "swizzle secret delete STRIPE_KEY --project billing -e prod --yes --json",
  ]);
  remove.action(
    async (
      name: string,
      inputOptions: ApiCommandOptions & ProjectOption & { readonly yes?: boolean },
    ) => {
      await runHandler(async () => {
        const options = await inEnvironment(inputOptions);
        requireYes(
          options.yes,
          `swizzle secret delete ${name}${projectFlag(options)} -e ${options.environment}`,
          `this deletes secret ${name} in ${options.environment}; its value is not recoverable and automations that declare it stop running.`,
        );
        const removed = await removeUnlessAbsent(
          "SECRET_NOT_FOUND",
          apiRequest(
            buildApiUrl(`/secrets/${encodeURIComponent(name)}`, options, inProject(options)),
            { method: "DELETE" },
          ),
        );
        respond(io, {
          secret: name,
          environment: options.environment,
          state: removed ? "deleted" : "already absent (no-op)",
        });
      });
    },
  );
}

// ---------- timeout-grant ----------

function registerTimeoutGrant(program: Command, io: CliIO, runHandler: RunHandler): void {
  const grant = program
    .command("timeout-grant")
    .description(
      "Let one automation run longer than the instance ceiling, SWIZZLE_MAX_RUN_TIMEOUT (owners, admins)",
    );
  withExamples(grant, ["swizzle timeout-grant", "swizzle timeout-grant set nightly-export 3h"]);

  const grantRow = (record: TimeoutGrantRecord) => ({
    automation: record.automationSlug,
    maxTimeout: formatRuntimeTimeoutMs(record.maxTimeoutMs),
    note: record.note,
  });

  const list = grant
    .command("list", { isDefault: true })
    .description("List the environment's timeout grants");
  withExamples(list, ["swizzle timeout-grant list", "swizzle timeout-grant list -e prod --json"]);
  list.action(async (inputOptions: ApiCommandOptions) => {
    await runHandler(async () => {
      const options = await inEnvironment(inputOptions);
      const response = await apiRequest<TimeoutGrantsResponse>(
        buildApiUrl("/timeout-grants", options),
      );
      if (response.grants.length === 0) {
        respond(
          io,
          {
            grants: `0 timeout grants in ${response.environment}; every automation has the instance ceiling`,
          },
          ["Run `swizzle timeout-grant set <name> <duration>` to raise one automation's ceiling"],
        );
        return;
      }
      respond(io, {
        environment: response.environment,
        count: response.grants.length,
        grants: response.grants.map(grantRow),
      });
    });
  });

  const show = grant
    .command("show")
    .description("Show one automation's timeout grant")
    .argument("[name]", "Automation name (default: the automation folder you are in)")
    .option("--exact", "Match the name exactly, without fuzzy matching");
  withExamples(show, [
    "swizzle timeout-grant show nightly-export",
    "swizzle timeout-grant show nightly-export -e prod --json",
  ]);
  show.action(
    async (name: string | undefined, inputOptions: ApiCommandOptions & ExactCommandOptions) => {
      await runHandler(async () => {
        const options = await inEnvironment(inputOptions);
        const resolved = await resolveAutomationNameOrDie(name, options);
        const response = await apiRequest<TimeoutGrantResponse>(
          buildApiUrl(`/automations/${resolved.slug}/timeout-grant`, options),
        );
        respond(
          io,
          response.grant === null
            ? {
                automation: resolved.slug,
                environment: response.environment,
                grant: "none; the instance ceiling applies",
              }
            : {
                ...grantRow(response.grant),
                environment: response.environment,
                maxTimeoutMs: response.grant.maxTimeoutMs,
                createdAt: response.grant.createdAt,
              },
        );
      });
    },
  );

  const set = grant
    .command("set")
    .description("Raise one automation's run-timeout ceiling; the same ceiling again is a no-op")
    .argument("<name>", "Automation name")
    .argument("<duration>", "Ceiling, such as 3h or 90m, as runtime.timeout takes it")
    .option("--note <note>", "Why it needs longer, stored with the grant")
    .option("--exact", "Match the name exactly, without fuzzy matching");
  withExamples(set, [
    "swizzle timeout-grant set nightly-export 3h --note 'full reindex'",
    "swizzle timeout-grant set nightly-export 90m -e prod --json",
  ]);
  set.action(
    async (
      name: string,
      duration: string,
      inputOptions: ApiCommandOptions & ExactCommandOptions & { readonly note?: string },
    ) => {
      await runHandler(async () => {
        // The parser runtime.timeout uses, so `3h` here means what it means in config.yaml.
        const maxTimeoutMs = parseRuntimeTimeout(duration, "duration");
        const options = await inEnvironment(inputOptions);
        const resolved = await resolveAutomationNameOrDie(name, options);
        const url = buildApiUrl(`/automations/${resolved.slug}/timeout-grant`, options);
        const { grant: current } = await apiRequest<TimeoutGrantResponse>(url);
        if (
          current !== null &&
          current.maxTimeoutMs === maxTimeoutMs &&
          (options.note === undefined || options.note === current.note)
        ) {
          respond(io, { ...grantRow(current), state: "already granted (no-op)" });
          return;
        }
        const response = await apiRequest<SetTimeoutGrantResponse>(url, {
          body: JSON.stringify({
            maxTimeoutMs,
            ...(options.note !== undefined ? { note: options.note } : {}),
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        });
        respond(
          io,
          {
            ...grantRow(response.grant),
            environment: response.grant.environment,
            state:
              current === null
                ? "granted"
                : `changed from ${formatRuntimeTimeoutMs(current.maxTimeoutMs)}`,
          },
          [
            `Set runtime.timeout up to ${duration} in ${resolved.slug}'s config.yaml, then run \`swizzle apply <dir>\``,
          ],
        );
      });
    },
  );

  const remove = grant
    .command("remove")
    .description("Remove an automation's timeout grant; no grant is a no-op. Takes the exact name")
    .argument("<name>", "Exact automation name")
    .option("--yes", "Confirm the removal (required)");
  withExamples(remove, [
    "swizzle timeout-grant remove nightly-export --yes",
    "swizzle timeout-grant remove nightly-export -e prod --yes --json",
  ]);
  remove.action(
    async (name: string, inputOptions: ApiCommandOptions & { readonly yes?: boolean }) => {
      await runHandler(async () => {
        const options = await inEnvironment(inputOptions);
        // Removal acts on the exact name only, so a near miss cannot strip another automation's grant.
        const resolved = await resolveAutomationNameOrDie(name, options, { destructive: true });
        requireYes(
          options.yes,
          `swizzle timeout-grant remove ${resolved.slug} -e ${options.environment}`,
          `${resolved.slug} falls back to the instance ceiling; a deployment whose runtime.timeout is above it fails its next run.`,
        );
        const removed = await removeUnlessAbsent(
          "TIMEOUT_GRANT_NOT_FOUND",
          apiRequest(buildApiUrl(`/automations/${resolved.slug}/timeout-grant`, options), {
            method: "DELETE",
          }),
        );
        respond(io, {
          automation: resolved.slug,
          environment: options.environment,
          state: removed ? "removed" : "no grant (no-op)",
        });
      });
    },
  );
}

// ---------- notify ----------

const EVENT_TYPES = ["dead-lettered", "repeated-failures"] as const;

/** Max rows the API returns per request; the CLI asks for one more to know whether more exist. */
const API_DELIVERY_LIMIT = 200;

interface RuleNumbers {
  readonly threshold?: number;
  readonly windowSeconds?: number;
  readonly cooldownSeconds?: number;
}

function ruleNumberOptions(command: Command): Command {
  return command
    .option("--threshold <count>", "Failures that make repeated-failures fire", parseCount)
    .option("--window-seconds <seconds>", "Window the failures are counted in", parseCount)
    .option("--cooldown-seconds <seconds>", "Quiet time after a notification", parseCount);
}

function ruleNumbers(options: RuleNumbers) {
  return {
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    ...(options.windowSeconds !== undefined ? { windowSeconds: options.windowSeconds } : {}),
    ...(options.cooldownSeconds !== undefined ? { cooldownSeconds: options.cooldownSeconds } : {}),
  };
}

function ruleRow(rule: NotificationRuleRecord) {
  return {
    id: rule.ruleId,
    automation: rule.automationSlug ?? "all",
    event: rule.eventType,
    enabled: rule.enabled,
  };
}

function registerNotify(program: Command, io: CliIO, runHandler: RunHandler): void {
  const notify = program
    .command("notify")
    .description("Manage your Telegram notification rules for failed and dead-lettered runs");
  withExamples(notify, [
    "swizzle notify",
    "swizzle notify create -a invoice-sync -t dead-lettered -c 123456789",
  ]);

  const list = notify
    .command("list", { isDefault: true })
    .description("List the environment's notification rules you may read");
  withExamples(list, ["swizzle notify list", "swizzle notify list -e prod --json"]);
  list.action(async (inputOptions: ApiCommandOptions) => {
    await runHandler(async () => {
      const options = await inEnvironment(inputOptions);
      const response = await apiRequest<NotificationRulesResponse>(
        buildApiUrl("/notifications/rules", options),
      );
      if (response.rules.length === 0) {
        respond(io, { rules: `0 notification rules in ${response.environment}` }, [
          "Run `swizzle notify create -t dead-lettered -c <chat-id>` to be told when a run dead-letters",
        ]);
        return;
      }
      respond(io, {
        environment: response.environment,
        count: response.rules.length,
        rules: response.rules.map((rule) => ({ ...ruleRow(rule), chatId: rule.chatId })),
      });
    });
  });

  const create = ruleNumberOptions(
    notify
      .command("create")
      .description("Create a notification rule of your own, for automations you may read")
      .option(
        "-a, --automation <name>",
        "Automation name (default: every automation of the project)",
      )
      .option(
        "-p, --project <project>",
        "Project of a rule without --automation (default: the profile's, else Default)",
      )
      .addOption(
        new Option("-t, --event-type <event>", "When it fires")
          .choices(EVENT_TYPES)
          .makeOptionMandatory(),
      )
      .requiredOption("-c, --chat-id <chatId>", "Telegram chat id")
      .option("--disabled", "Create the rule disabled"),
  );
  withExamples(create, [
    "swizzle notify create -a invoice-sync -t dead-lettered -c 123456789",
    "swizzle notify create -p billing -t repeated-failures -c 123456789 --threshold 3 --window-seconds 3600 --json",
  ]);
  create.action(
    async (
      inputOptions: ApiCommandOptions &
        RuleNumbers & {
          readonly automation?: string;
          readonly chatId: string;
          readonly disabled?: boolean;
          readonly eventType: (typeof EVENT_TYPES)[number];
          readonly project?: string;
        },
    ) => {
      await runHandler(async () => {
        const options = await inEnvironment(inputOptions);
        const rule = await apiRequest<NotificationRuleRecord>(
          buildApiUrl("/notifications/rules", options),
          {
            body: JSON.stringify({
              ...(options.automation !== undefined ? { automationName: options.automation } : {}),
              ...(options.project !== undefined ? { project: options.project } : {}),
              chatId: options.chatId,
              enabled: options.disabled !== true,
              eventType: options.eventType,
              ...ruleNumbers(options),
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        respond(io, { rule: { ...ruleRow(rule), chatId: rule.chatId }, state: "created" }, [
          `Run \`swizzle notify deliveries${options.automation !== undefined ? ` -a ${options.automation}` : ""}\` to see what it sent`,
        ]);
      });
    },
  );

  const update = ruleNumberOptions(
    notify
      .command("update")
      .description("Change a notification rule")
      .argument("<ruleId>", "Rule id from `swizzle notify list`")
      .option("--chat-id <chatId>", "Telegram chat id")
      .addOption(new Option("--enable", "Enable the rule").conflicts("disable"))
      .addOption(new Option("--disable", "Disable the rule").conflicts("enable")),
  );
  withExamples(update, [
    "swizzle notify update 4d2f… --disable",
    "swizzle notify update 4d2f… --threshold 5 --cooldown-seconds 1800 --json",
  ]);
  update.action(
    async (
      ruleId: string,
      options: ApiCommandOptions &
        RuleNumbers & {
          readonly chatId?: string;
          readonly disable?: boolean;
          readonly enable?: boolean;
        },
    ) => {
      await runHandler(async () => {
        const rule = await apiRequest<NotificationRuleRecord>(
          instanceUrl(`/notifications/rules/${encodeURIComponent(ruleId)}`, options),
          {
            body: JSON.stringify({
              ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
              ...(options.enable === true ? { enabled: true } : {}),
              ...(options.disable === true ? { enabled: false } : {}),
              ...ruleNumbers(options),
            }),
            headers: { "content-type": "application/json" },
            method: "PATCH",
          },
        );
        respond(io, {
          rule: {
            ...ruleRow(rule),
            chatId: rule.chatId,
            threshold: rule.threshold,
            windowSeconds: rule.windowSeconds,
            cooldownSeconds: rule.cooldownSeconds,
          },
          state: "updated",
        });
      });
    },
  );

  const deliveries = notify
    .command("deliveries")
    .description(
      "List recent deliveries of your notification rules, or of every rule for an instance owner or admin, newest first",
    )
    .option("-a, --automation <name>", "Only this automation's")
    .addOption(new Option("-t, --event-type <event>", "Only this event").choices(EVENT_TYPES))
    .option("--limit <count>", "Rows to show (default: 50)", parseCount, 50);
  withExamples(deliveries, [
    "swizzle notify deliveries",
    "swizzle notify deliveries -a invoice-sync -t dead-lettered --limit 10 --json",
  ]);
  deliveries.action(
    async (
      inputOptions: ApiCommandOptions &
        PaginationCommandOptions & { readonly automation?: string; readonly eventType?: string },
    ) => {
      await runHandler(async () => {
        const options = await inEnvironment(inputOptions);
        const limit = options.limit ?? 50;
        const response = await apiRequest<NotificationDeliveriesResponse>(
          buildApiUrl("/notifications/deliveries", options, {
            ...(options.automation !== undefined ? { automation: options.automation } : {}),
            ...(options.eventType !== undefined ? { eventType: options.eventType } : {}),
            limit: Math.min(limit + 1, API_DELIVERY_LIMIT),
          }),
        );
        const shown = response.deliveries.slice(0, limit);
        if (shown.length === 0) {
          respond(io, { deliveries: `0 notification deliveries in ${response.environment}` });
          return;
        }
        const more =
          response.deliveries.length > limit || response.deliveries.length === API_DELIVERY_LIMIT;
        respond(
          io,
          {
            environment: response.environment,
            count: more ? `${shown.length} shown, more exist` : shown.length,
            deliveries: shown.map((delivery) => ({
              at: delivery.createdAt,
              automation: delivery.automationSlug,
              event: delivery.eventType,
              status: delivery.status,
              ...(delivery.errorMessage !== null ? { error: delivery.errorMessage } : {}),
            })),
          },
          more
            ? [
                limit * 4 <= API_DELIVERY_LIMIT
                  ? `Run \`swizzle notify deliveries --limit ${limit * 4}\` for more`
                  : "Narrow it with -a <automation> or -t <event>; the API answers at most 200 rows",
              ]
            : [],
        );
      });
    },
  );

  const remove = notify
    .command("delete")
    .description("Delete a notification rule; a missing one is a no-op")
    .argument("<ruleId>", "Rule id from `swizzle notify list`");
  withExamples(remove, ["swizzle notify delete 4d2f…", "swizzle notify delete 4d2f… --json"]);
  remove.action(async (ruleId: string, options: ApiCommandOptions) => {
    await runHandler(async () => {
      const removed = await removeUnlessAbsent(
        "NOTIFICATION_RULE_NOT_FOUND",
        apiRequest(instanceUrl(`/notifications/rules/${encodeURIComponent(ruleId)}`, options), {
          method: "DELETE",
        }),
      );
      respond(io, { rule: ruleId, state: removed ? "deleted" : "already absent (no-op)" });
    });
  });
}
