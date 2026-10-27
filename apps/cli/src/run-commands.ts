import { readFile } from "node:fs/promises";
import path from "node:path";
import { isFinishedRun, RUN_STATUSES } from "@swizzle/db";
import { buildDiagnosis } from "@swizzle/runtime";
import type {
  AutomationSecretsResponse,
  CancelRunResponse,
  DeploymentsResponse,
  ResumeRunResponse,
  RunsResponse,
} from "@swizzle/runtime/http-contract";
import { type Command, Option } from "commander";
import { apiRequest } from "./api.js";
import { resolveAutomationNameOrDie } from "./automation-api.js";
import {
  type ApiCommandOptions,
  addFieldsOption,
  buildApiUrl,
  type ExactCommandOptions,
  type FieldsCommandOptions,
  type PaginationCommandOptions,
  parseCount,
  parseRunId,
  type RunHandler,
  type TimeRangeCommandOptions,
  withExamples,
} from "./command-support.js";
import { parseTimeRange } from "./context.js";
import { resolveCommandEnvironment } from "./environment-guard.js";
import { AgentError, type CliIO, EXIT_CODES, respond, selectFields } from "./output.js";
import {
  type LogWindowOptions,
  runStderr,
  runView,
  runViewTruncated,
  waitText,
  windowLog,
} from "./run-log-formatting.js";
import { followRunLogs } from "./run-log-stream.js";
import type { RunDetailRecord, RunSummaryRecord } from "./run-records.js";
import { aggregateRunStats, filterRunsByTimeRange } from "./run-stats.js";

export function registerRunCommands(program: Command, io: CliIO, runHandler: RunHandler): void {
  registerLogs(program, io, runHandler);
  registerRuns(program, io, runHandler);
  registerApprovals(program, io, runHandler);
  registerDiagnose(program, io, runHandler);
  registerStats(program, io, runHandler);
}

type Targeted<T> = T & { readonly environment: string };

async function targeted<T extends ApiCommandOptions>(options: T): Promise<Targeted<T>> {
  return { ...options, environment: await resolveCommandEnvironment(options) };
}

/** Max rows the API returns per request; the CLI asks for one more to know whether more exist. */
const API_RUN_LIMIT = 200;

async function fetchRuns(
  options: Targeted<ApiCommandOptions>,
  query: Record<string, string | number | boolean>,
  limit: number,
): Promise<{ readonly runs: readonly RunSummaryRecord[]; readonly more: boolean }> {
  const response = await apiRequest<RunsResponse>(
    buildApiUrl("/dashboard/runs", options, {
      ...query,
      limit: Math.min(limit + 1, API_RUN_LIMIT),
    }),
  );
  return {
    more: response.runs.length > limit || response.runs.length === API_RUN_LIMIT,
    runs: response.runs.slice(0, limit),
  };
}

// ---------- logs ----------

function logWindowOptions(): Option[] {
  return [
    new Option("--head <lines>", "Only the first N lines of each stream")
      .argParser(parseCount)
      .conflicts(["tail", "full"]),
    new Option("--tail <lines>", "Only the last N lines of each stream")
      .argParser(parseCount)
      .conflicts(["full"]),
    new Option("--full", "Print both streams whole (can be large)"),
  ];
}

function registerLogs(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("logs")
    .description(
      "Print a run's logs: the stderr of each attempt and its stdout result. Default: the automation's latest run",
    )
    .argument("[automationName]", "Automation name (default: detected from cwd)")
    .option("--run <runId>", "The run to print instead of the latest one", parseRunId)
    .option("--follow", "Print log lines as they arrive until the run ends, then its result")
    .option("--exact", "Disable fuzzy name matching");
  for (const option of logWindowOptions()) command.addOption(option);
  withExamples(command, [
    "swizzle logs --run 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41 --follow",
    "swizzle logs hello-webhook --tail 50",
    "swizzle logs hello-webhook -e production --full",
  ]);
  command.action(
    async (
      automationName: string | undefined,
      inputOptions: ApiCommandOptions &
        ExactCommandOptions &
        LogWindowOptions & { readonly follow?: boolean; readonly run?: string },
    ) => {
      await runHandler(async () => {
        const options = await targeted(inputOptions);
        const runId = options.run ?? (await latestRunId(automationName, options));
        if (options.follow === true) await followRunLogs(io, options, runId);
        const run = await apiRequest<RunDetailRecord>(
          buildApiUrl(`/runs/${encodeURIComponent(runId)}`, options),
        );
        const stdout = windowLog(run.stdout ?? "", options);
        const stderr = windowLog(runStderr(run), options);
        const terminal = isFinishedRun(run.status);
        respond(
          io,
          {
            run: {
              id: run.runId,
              automation: run.automationSlug ?? run.automationName ?? null,
              status: run.status,
              ...(run.errorCode != null
                ? { error: `${run.errorCode}: ${run.errorMessage ?? ""}`.trim() }
                : {}),
            },
            ...(options.follow === true ? {} : { stderr: stderr.text || "(empty)" }),
            stdout: stdout.text || "(empty)",
          },
          [
            ...(stdout.truncated || stderr.truncated
              ? [
                  `Run \`swizzle logs --run ${run.runId} --full\` for all ${stdout.totalBytes + stderr.totalBytes} bytes`,
                ]
              : []),
            ...(terminal
              ? []
              : [`Run \`swizzle logs --run ${run.runId} --follow\` to watch it to the end`]),
            ...(run.status === "failed" || run.status === "dead-lettered"
              ? [`Run \`swizzle diagnose ${run.runId}\` for the likely cause and a fix`]
              : []),
          ],
        );
      });
    },
  );
}

/** The run `logs` shows without `--run`: the automation's active run, else its newest. */
async function latestRunId(
  automationName: string | undefined,
  options: Targeted<ApiCommandOptions & ExactCommandOptions>,
): Promise<string> {
  const resolved = await resolveAutomationNameOrDie(automationName, options);
  const { runs } = await fetchRuns(options, { automation: resolved.slug }, 10);
  const latest =
    runs.find((run) => run.status === "running") ??
    runs.find((run) => run.status === "waiting") ??
    runs.find((run) => run.status === "queued") ??
    runs[0];
  if (latest === undefined && resolved.match === "unlisted") {
    throw new AgentError({
      code: "AUTOMATION_NOT_FOUND",
      fixCommand: `swizzle list -e ${options.environment}`,
      message: `You see no automation named ${resolved.slug} in ${options.environment}.`,
    });
  }
  if (latest === undefined) {
    throw new AgentError({
      code: "RUN_NOT_FOUND",
      fixCommand: `swizzle trigger ${resolved.slug} -e ${options.environment}`,
      message: `${resolved.slug} has no runs in ${options.environment} yet.`,
    });
  }
  return latest.runId;
}

// ---------- runs ----------

const RUN_FIELDS = ["id", "automation", "status", "queuedAt"] as const;

function runRow(run: RunSummaryRecord) {
  return {
    attempts: `${run.attemptsMade}/${run.attemptsMax}`,
    automation: run.automationSlug ?? run.automationName ?? null,
    id: run.runId,
    queuedAt: run.queuedAt,
    status: run.status,
    trigger: run.triggerType,
    waitingFor: run.status === "waiting" ? waitText(run.wait) : null,
  };
}

function registerRuns(program: Command, io: CliIO, runHandler: RunHandler): void {
  const runs = program
    .command("runs")
    .description("List runs, newest first, or inspect, cancel or resume one");
  withExamples(runs, [
    "swizzle runs hello-webhook --status failed --since 1d",
    "swizzle runs inspect 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41",
  ]);

  const list = addFieldsOption(
    runs
      .command("list", { isDefault: true })
      .description("List runs, newest first (the default of `swizzle runs`)")
      .argument("[automationName]", "Only this automation's runs")
      .option(
        "-s, --status <status>",
        `Only runs in this status (${RUN_STATUSES.join(", ")}); comma-separated for several`,
      )
      .option("-t, --trigger <type>", "Only runs started this way (webhook, cron, chain, manual)")
      .option("--since <value>", "Only runs queued at/after this time (ISO or 1h/2d/1w)")
      .option("--until <value>", "Only runs queued before this time")
      .option("--limit <n>", "Maximum number of runs (at most 200)", parseCount, 50)
      .option("--exact", "Disable fuzzy name matching"),
    [...RUN_FIELDS],
  );
  withExamples(list, [
    "swizzle runs list hello-webhook --limit 10",
    "swizzle runs list --status failed,dead-lettered --since 1d --fields trigger,attempts",
  ]);
  list.action(
    async (
      automationName: string | undefined,
      inputOptions: ApiCommandOptions &
        ExactCommandOptions &
        FieldsCommandOptions &
        PaginationCommandOptions &
        TimeRangeCommandOptions & { readonly status?: string; readonly trigger?: string },
    ) => {
      await runHandler(async () => {
        const options = await targeted(inputOptions);
        const range = parseTimeRange(options.since, options.until);
        const resolved =
          automationName === undefined
            ? undefined
            : await resolveAutomationNameOrDie(automationName, options);
        const slug = resolved?.slug;
        const limit = options.limit ?? 50;
        const page = await fetchRuns(
          options,
          {
            ...(slug !== undefined ? { automation: slug } : {}),
            ...(options.status !== undefined ? { status: options.status } : {}),
            ...(options.trigger !== undefined ? { triggerType: options.trigger } : {}),
          },
          limit,
        );
        const rows = selectFields(
          filterRunsByTimeRange(page.runs, range).map(runRow),
          RUN_FIELDS,
          options.fields,
        );
        respond(
          io,
          {
            environment: options.environment,
            ...(slug !== undefined ? { automation: slug } : {}),
            ...(rows.length === 0
              ? {
                  runs: `0 runs${options.status !== undefined ? ` with status ${options.status}` : ""}${options.since !== undefined ? ` since ${options.since}` : ""}${resolved?.match === "unlisted" ? `; you see no automation named ${slug} in ${options.environment}` : ""}`,
                }
              : {
                  count: page.more ? `${rows.length} shown, more exist` : rows.length,
                  runs: rows,
                }),
          },
          rows.length === 0
            ? [
                ...(resolved?.match === "unlisted"
                  ? []
                  : [
                      slug === undefined
                        ? "Run `swizzle trigger <name>` to start a run"
                        : `Run \`swizzle trigger ${slug} -e ${options.environment}\` to start a run`,
                    ]),
                ...(slug !== undefined ? ["Run `swizzle list` for the deployed automations"] : []),
              ]
            : [
                "Run `swizzle runs inspect <id>` for a run's status, result and log tail",
                ...(page.more
                  ? ["Narrow with --since, --status or an automation name, or raise --limit"]
                  : []),
              ],
        );
      });
    },
  );

  const inspect = runs
    .command("inspect")
    .description("Show one run: status, result, error, what it waits for, and its log tail")
    .argument("<runId>", "Run ID", parseRunId)
    .option("--full", "Print stdout, stderr and every attempt whole");
  withExamples(inspect, [
    "swizzle runs inspect 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41",
    "swizzle runs inspect 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41 --full --json",
  ]);
  inspect.action(
    async (runId: string, inputOptions: ApiCommandOptions & { readonly full?: boolean }) => {
      await runHandler(async () => {
        const options = await targeted(inputOptions);
        const run = await apiRequest<RunDetailRecord>(
          buildApiUrl(`/runs/${encodeURIComponent(runId)}`, options),
        );
        respond(io, { run: runView(run, options.full === true) }, inspectHelp(run, options.full));
      });
    },
  );

  const cancel = runs
    .command("cancel")
    .description("Cancel a queued, waiting or running run; a finished one is a no-op")
    .argument("<runId>", "Run ID", parseRunId);
  withExamples(cancel, [
    "swizzle runs cancel 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41",
    "swizzle runs cancel 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41 -e production",
  ]);
  cancel.action(async (runId: string, inputOptions: ApiCommandOptions) => {
    await runHandler(async () => {
      const options = await targeted(inputOptions);
      const response = await apiRequest<CancelRunResponse>(
        buildApiUrl(`/runs/${encodeURIComponent(runId)}/cancel`, options),
        { method: "POST" },
      );
      respond(io, {
        run: { id: response.run.runId, status: response.run.status },
        state: response.alreadyTerminal
          ? `already ${response.run.status} (no-op)`
          : `cancelled (${response.run.deadLetterReason ?? "user-cancelled"})`,
      });
    });
  });

  const resolveEvent = runs
    .command("resolve-event")
    .description("Resume a run that waits for an external event, with the event's value")
    .argument("<runId>", "Run ID", parseRunId)
    .argument("<stepKey>", "Event step key (`runs inspect` shows it under waitingFor)")
    .option("-p, --payload <json>", "Inline JSON value for the event")
    .option("-f, --payload-file <path>", "Path to a JSON value file");
  withExamples(resolveEvent, [
    "swizzle runs resolve-event 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41 invoice-paid --payload '{\"paid\":true}'",
    "swizzle runs resolve-event 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41 invoice-paid --payload-file event.json",
  ]);
  resolveEvent.action(
    async (
      runId: string,
      stepKey: string,
      inputOptions: ApiCommandOptions & {
        readonly payload?: string;
        readonly payloadFile?: string;
      },
    ) => {
      await runHandler(async () => {
        const options = await targeted(inputOptions);
        const value = await resolveEventPayload(options);
        const result = await apiRequest<ResumeRunResponse>(
          buildApiUrl(
            `/runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(stepKey)}`,
            options,
          ),
          {
            body: JSON.stringify({ value }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        respond(io, { run: result.runId, step: result.stepKey, resumed: result.resumed }, [
          `Run \`swizzle logs --run ${result.runId} --follow\` to watch it continue`,
        ]);
      });
    },
  );
}

function inspectHelp(run: RunDetailRecord, full: boolean | undefined): string[] {
  const help: string[] = [];
  if (run.status === "waiting" && run.wait?.reason === "approval") {
    const who = run.wait.assignee?.label ?? "A person who may run it here";
    const where = run.dashboardUrl ?? "the run's panel in the dashboard";
    help.push(`${who} decides this approval signed in at ${where}; a token cannot`);
  }
  if (run.status === "waiting" && run.wait?.reason === "event") {
    help.push(
      `Run \`swizzle runs resolve-event ${run.runId} ${run.wait.stepKey} --payload '<json>'\` to resume it`,
    );
  }
  if (run.placement !== null) {
    help.push(`Run \`swizzle diagnose ${run.runId}\` to see which worker it waits for`);
  }
  if (run.status === "failed" || run.status === "dead-lettered") {
    help.push(`Run \`swizzle diagnose ${run.runId}\` for the likely cause and a fix`);
  }
  if (full !== true && runViewTruncated(run)) {
    help.push(`Run \`swizzle logs --run ${run.runId} --full\` for the whole log`);
  }
  return help;
}

async function resolveEventPayload(options: {
  readonly payload?: string;
  readonly payloadFile?: string;
}): Promise<unknown> {
  if (options.payload !== undefined && options.payloadFile !== undefined) {
    throw new AgentError({
      code: "PAYLOAD_OPTIONS_CONFLICT",
      exitCode: EXIT_CODES.usage,
      hint: "Pass either --payload or --payload-file, not both.",
      message: "--payload and --payload-file were both given.",
    });
  }
  if (options.payload !== undefined) return parseEventPayloadJson(options.payload, "inline");
  if (options.payloadFile !== undefined) {
    const raw = await readFile(path.resolve(options.payloadFile), "utf8");
    return parseEventPayloadJson(raw, options.payloadFile);
  }
  return null;
}

function parseEventPayloadJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AgentError({
      code: source === "inline" ? "INVALID_PAYLOAD_JSON" : "INVALID_PAYLOAD_FILE_JSON",
      exitCode: EXIT_CODES.validation,
      hint:
        source === "inline"
          ? "Quote the JSON for your shell, or pass a file with --payload-file."
          : "Fix the JSON file contents.",
      message: `Could not parse payload JSON from ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

// ---------- approvals ----------

const APPROVAL_FIELDS = ["run", "automation", "step", "assignee"] as const;

function registerApprovals(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = addFieldsOption(
    program
      .command("approvals")
      .description(
        "List runs waiting for an approval you may decide. A signed-in person decides each one in the dashboard; a token only lists them",
      )
      .argument("[automationName]", "Only this automation's approvals")
      .option("--limit <n>", "Maximum number of approvals (at most 200)", parseCount, 50)
      .option("--exact", "Disable fuzzy name matching"),
    [...APPROVAL_FIELDS],
  );
  withExamples(command, [
    "swizzle approvals",
    "swizzle approvals invoice-approval -e production --fields waitingSince,timeout",
  ]);
  command.action(
    async (
      automationName: string | undefined,
      inputOptions: ApiCommandOptions &
        ExactCommandOptions &
        FieldsCommandOptions &
        PaginationCommandOptions,
    ) => {
      await runHandler(async () => {
        const options = await targeted(inputOptions);
        const slug =
          automationName === undefined
            ? undefined
            : (await resolveAutomationNameOrDie(automationName, options)).slug;
        const page = await fetchRuns(
          options,
          { approvalOnly: true, ...(slug !== undefined ? { automation: slug } : {}) },
          options.limit ?? 50,
        );
        const rows = selectFields(
          page.runs.flatMap((run) =>
            run.wait?.reason === "approval"
              ? [
                  {
                    assignee: run.wait.assignee?.label ?? "anyone who may run it",
                    automation: run.automationSlug ?? run.automationName ?? null,
                    run: run.runId,
                    step: run.wait.stepKey,
                    timeout: run.wait.until,
                    waitingSince: run.wait.startedAt,
                  },
                ]
              : [],
          ),
          APPROVAL_FIELDS,
          options.fields,
        );
        respond(
          io,
          {
            environment: options.environment,
            ...(rows.length === 0
              ? { approvals: "0 runs wait for an approval you may decide" }
              : {
                  count: page.more ? `${rows.length} shown, more exist` : rows.length,
                  approvals: rows,
                }),
          },
          rows.length === 0
            ? []
            : [
                "Run `swizzle runs inspect <run>` for what the automation asks and the page where its assignee decides it; a token cannot",
              ],
        );
      });
    },
  );
}

// ---------- diagnose ----------

function registerDiagnose(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("diagnose")
    .description(
      "Explain a failed or stuck run: likely cause, evidence from run, deployment and secrets, and fixes",
    )
    .argument("<runId>", "Run ID to diagnose", parseRunId);
  withExamples(command, [
    "swizzle diagnose 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41",
    "swizzle diagnose 0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41 -e production --json",
  ]);
  command.action(async (runId: string, inputOptions: ApiCommandOptions) => {
    await runHandler(async () => {
      const options = await targeted(inputOptions);
      const run = await apiRequest<RunDetailRecord>(
        buildApiUrl(`/runs/${encodeURIComponent(runId)}`, options),
      );
      const slug = run.automationSlug ?? run.automationName ?? "";
      // Secrets and deployments sharpen the diagnosis; without them it still names a cause.
      const [secretHealth, deployments] = await Promise.all([
        slug
          ? apiRequest<AutomationSecretsResponse>(
              buildApiUrl(`/automations/${slug}/secrets`, options),
            ).catch(() => null)
          : null,
        slug
          ? apiRequest<DeploymentsResponse>(
              buildApiUrl(`/automations/${slug}/deployments`, options),
            ).catch(() => null)
          : null,
      ]);
      const diagnosis = buildDiagnosis(run, secretHealth?.secrets, deployments?.deployments);
      respond(
        io,
        {
          run: diagnosis.runId,
          automation: diagnosis.automation,
          status: diagnosis.status,
          attempts: `${diagnosis.attempts.made}/${diagnosis.attempts.max}`,
          likelyCause: diagnosis.likelyCause,
          evidence: diagnosis.evidence.map(({ kind, detail }) => ({ kind, detail })),
          fixes:
            diagnosis.suggestedFixes.length === 0
              ? "none suggested"
              : diagnosis.suggestedFixes.map((fix) => ({
                  confidence: Number(fix.confidence.toFixed(2)),
                  command: fix.command ?? null,
                  rationale: fix.rationale,
                })),
        },
        diagnosis.suggestedFixes.length === 0
          ? [`Run \`swizzle logs --run ${diagnosis.runId} --full\` for the complete output`]
          : diagnosis.suggestedFixes.flatMap((fix) =>
              fix.command?.startsWith("swizzle ") === true ? [`Run \`${fix.command}\``] : [],
            ),
      );
    });
  });
}

// ---------- stats ----------

function registerStats(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("stats")
    .description("Count an automation's runs by status, with its success rate and top errors")
    .argument("[automationName]", "Automation name (default: detected from cwd)")
    .option("--since <value>", "Count runs queued at/after this time", "24h")
    .option("--until <value>", "Count runs queued before this time")
    .option("--limit <n>", "Maximum number of runs to count (at most 200)", parseCount, 200)
    .option("--exact", "Disable fuzzy name matching");
  withExamples(command, ["swizzle stats hello-webhook", "swizzle stats hello-webhook --since 7d"]);
  command.action(
    async (
      automationName: string | undefined,
      inputOptions: ApiCommandOptions &
        ExactCommandOptions &
        PaginationCommandOptions &
        TimeRangeCommandOptions,
    ) => {
      await runHandler(async () => {
        const options = await targeted(inputOptions);
        const resolved = await resolveAutomationNameOrDie(automationName, options);
        const range = parseTimeRange(options.since ?? "24h", options.until);
        const page = await fetchRuns(options, { automation: resolved.slug }, options.limit ?? 200);
        const counted = filterRunsByTimeRange(page.runs, range);
        // Error codes live on the run detail; the 20 newest failures are enough to rank them.
        const failures = await Promise.all(
          counted
            .filter((run) => run.status === "failed" || run.status === "dead-lettered")
            .slice(0, 20)
            .map((run) =>
              apiRequest<RunDetailRecord>(buildApiUrl(`/runs/${run.runId}`, options)).catch(
                () => null,
              ),
            ),
        );
        if (counted.length === 0 && resolved.match === "unlisted") {
          respond(
            io,
            {
              automation: resolved.slug,
              environment: options.environment,
              runs: `0 runs; you see no automation named ${resolved.slug} in ${options.environment}`,
            },
            ["Run `swizzle list` for the deployed automations"],
          );
          return;
        }
        const stats = aggregateRunStats(
          counted,
          failures.filter((entry): entry is RunDetailRecord => entry !== null),
        );
        respond(
          io,
          {
            automation: resolved.slug,
            environment: options.environment,
            since: range.since ?? null,
            ...(page.more ? { counted: `the newest ${counted.length} runs; more exist` } : {}),
            ...stats,
            successRate:
              stats.successRate === null ? null : `${(stats.successRate * 100).toFixed(1)}%`,
          },
          stats.lastFailure === null
            ? []
            : [`Run \`swizzle diagnose ${stats.lastFailure.runId}\` for the last failure`],
        );
      });
    },
  );
}
