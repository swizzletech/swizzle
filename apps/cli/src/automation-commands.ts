import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatIntervalMs } from "@swizzle/config";

import { formatRuntimeTimeoutMs } from "@swizzle/runtime";
import type {
  AutomationDetailResponse as AutomationDetailRecord,
  CronNextRun,
  DeleteStateResponse,
  SetStateResponse,
  StateListResponse,
  StateValueResponse,
  TimeoutGrantResponse,
  TriggerRunResponse,
  TriggerStatusResponse,
} from "@swizzle/runtime/http-contract";
import type { Command } from "commander";

import { apiRequest } from "./api.js";
import {
  type AutomationSummaryRecord,
  listAutomations,
  type ReadinessRecord,
  resolveAutomationNameOrDie,
} from "./automation-api.js";
import {
  type ApiCommandOptions,
  addFieldsOption,
  buildApiUrl,
  type ExactCommandOptions,
  type FieldsCommandOptions,
  type RunHandler,
  showsSubcommands,
  withExamples,
} from "./command-support.js";
import { resolveCommandEnvironment } from "./environment-guard.js";
import { AgentError, type CliIO, EXIT_CODES, respond, selectFields, warn } from "./output.js";

export function registerAutomationCommands(
  program: Command,
  io: CliIO,
  runHandler: RunHandler,
): void {
  registerList(program, io, runHandler);
  registerInspect(program, io, runHandler);
  registerResolve(program, io, runHandler);
  registerState(program, io, runHandler);
  registerTrigger(program, io, runHandler);
}

type InspectTimeoutGrant = NonNullable<TimeoutGrantResponse["grant"]>;

type TargetOptions = ApiCommandOptions & ExactCommandOptions;

async function targeted<T extends ApiCommandOptions>(
  options: T,
): Promise<T & { readonly environment: string }> {
  return { ...options, environment: await resolveCommandEnvironment(options) };
}

// ---------- list ----------

const LIST_FIELDS = ["name", "trigger", "status", "lastRun"] as const;

/** One automation as `list` shows it; `--fields` picks from every key. */
function automationRow(automation: AutomationSummaryRecord) {
  const readiness = automation.activeDeployment.readiness;
  const notReady = readiness.status === "not-ready";
  return {
    deployedAt: automation.activeDeployment.deployedAt,
    lastRun: automation.lastRun?.status ?? "never",
    lastRunAt: automation.lastRun?.queuedAt ?? null,
    name: automation.automationSlug,
    notReady: notReady ? readiness.errors.map((issue) => issue.message).join("; ") : null,
    secrets: automation.requiredSecrets.map((secret) => secret.name).join(" "),
    status: notReady ? "not-ready" : (automation.trigger?.status ?? "none"),
    title: automation.automationName,
    trigger: automation.activeDeployment.triggerType,
    version: automation.activeDeployment.version,
  };
}

function registerList(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = addFieldsOption(
    program.command("list").description("List the automations deployed in the environment"),
    [...LIST_FIELDS],
  );
  withExamples(command, [
    "swizzle list",
    "swizzle list -e production --fields version,deployedAt",
    "swizzle list --json",
  ]);
  command.action(async (inputOptions: ApiCommandOptions & FieldsCommandOptions) => {
    await runHandler(async () => {
      const options = await targeted(inputOptions);
      const automations = await listAutomations(options);
      const rows = selectFields(automations.map(automationRow), LIST_FIELDS, options.fields);
      respond(
        io,
        { environment: options.environment, count: rows.length, automations: rows },
        rows.length === 0
          ? [
              "Run `swizzle apply <dir>` to deploy an automation",
              "Run `swizzle init <dir>` to scaffold one",
            ]
          : [
              "Run `swizzle inspect <name>` for one automation's trigger, secrets and recent runs",
              "Run `swizzle trigger <name>` to start a run",
            ],
      );
    });
  });
}

// ---------- inspect ----------

function registerInspect(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("inspect")
    .description(
      "Show one deployed automation: deployment, trigger, readiness, secrets, recent runs",
    )
    .argument("[automationName]", "Automation name (default: detected from cwd)")
    .option("--full", "Add the whole dashboard record: deployment history, runtime, every run")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(command, [
    "swizzle inspect hello-webhook",
    "swizzle inspect hello-webhook -e production --full",
    "swizzle inspect",
  ]);
  command.action(
    async (
      automationName: string | undefined,
      inputOptions: TargetOptions & { readonly full?: boolean },
    ) => {
      await runHandler(async () => {
        const options = await targeted(inputOptions);
        const resolved = await resolveAutomationNameOrDie(automationName, options);
        const detail = await apiRequest<AutomationDetailRecord>(
          buildApiUrl(`/dashboard/automations/${resolved.slug}`, options),
        );
        // A 404 means no grant; genuine failures (auth, 5xx, unreachable) still surface, so
        // inspect never hides an active grant.
        const timeoutGrantResponse = await apiRequest<TimeoutGrantResponse>(
          buildApiUrl(`/automations/${resolved.slug}/timeout-grant`, options),
          { acceptNotFound: true },
        );
        const automation = automationDetail(detail, timeoutGrantResponse?.grant ?? null);
        respond(
          io,
          options.full === true ? { automation, record: detail } : { automation },
          inspectHelp(detail),
        );
      });
    },
  );
}

function inspectNextRun(nextRun: CronNextRun) {
  if (nextRun?.kind === "unserved") {
    return { scheduler: `none serves ${nextRun.environment}; this trigger starts no runs` };
  }
  if (nextRun?.kind === "at") {
    return { nextRunAt: nextRun.at };
  }
  return {};
}

function automationDetail(
  detail: AutomationDetailRecord,
  timeoutGrant: InspectTimeoutGrant | null,
) {
  const deployment = detail.activeDeployment;
  const trigger = detail.trigger;
  const nextRun = trigger && "nextRun" in trigger ? trigger.nextRun : null;
  const runs = detail.recentRuns;
  const runtime = deployment.runtimeSnapshot;
  return {
    name: detail.automationSlug,
    title: detail.automationName,
    environment: detail.environment,
    deployment: `#${deployment.seq} v${deployment.version} ${deployment.deploymentId}`,
    deployedAt: deployment.deployedAt,
    runtime: `${runtime.language} / ${runtime.execution_mode === "container" ? "sandbox (container)" : runtime.execution_mode} / ${runtime.profile}`,
    apiCheck:
      detail.apiCheck?.mode === "active"
        ? {
            mode: "active",
            status: detail.apiCheck.record?.status ?? "pending",
            checkedAt: detail.apiCheck.record?.lastCheckedAt ?? null,
            warning: detail.apiCheck.record?.lastWarning ?? null,
          }
        : detail.apiCheck,
    trigger: `${trigger?.triggerType ?? "none"} (${trigger?.status ?? "none"})`,
    ...(trigger?.webhookUrl ? { webhookUrl: trigger.webhookUrl } : {}),
    ...(trigger?.cronSchedule ? { schedule: trigger.cronSchedule } : {}),
    ...(trigger?.cronIntervalMs ? { every: formatIntervalMs(trigger.cronIntervalMs) } : {}),
    ...inspectNextRun(nextRun),
    ...(trigger?.triggerType === "chain"
      ? {
          chain: `after ${chainSourcesText(trigger)} ${trigger.chainOnStatus ?? "succeeded"}, payload ${trigger.chainPayloadMode ?? "result"}`,
        }
      : {}),
    ready: readinessText(deployment.readiness),
    secrets:
      detail.requiredSecrets.length === 0
        ? "none"
        : detail.requiredSecrets.map((secret) => ({
            name: secret.name,
            state: secret.state,
          })),
    vars: Object.keys(deployment.vars).length === 0 ? "none" : deployment.vars,
    timeoutGrant:
      timeoutGrant === null
        ? "none"
        : `${formatRuntimeTimeoutMs(timeoutGrant.maxTimeoutMs)}${timeoutGrant.note ? ` (${timeoutGrant.note})` : ""}`,
    recentRuns: runSummary(runs),
    ...(runs[0] !== undefined
      ? {
          lastRun: `${runs[0].status} ${runs[0].runId} at ${runs[0].queuedAt}${
            runs[0].errorCode != null ? `: ${runs[0].errorCode}` : ""
          }`,
        }
      : {}),
    deployments: detail.deploymentHistory.length,
  };
}

/** "nightly-fetch", "a, b and 1 automation you cannot see"; "?" for a source that is gone. */
function chainSourcesText(trigger: {
  readonly chainHiddenSourceCount: number;
  readonly chainSourceAutomationNames: readonly string[];
}): string {
  const hidden = trigger.chainHiddenSourceCount;
  const sources = [
    ...trigger.chainSourceAutomationNames,
    ...(hidden === 0 ? [] : [`${hidden} automation${hidden === 1 ? "" : "s"} you cannot see`]),
  ];
  return sources.length === 0 ? "?" : sources.join(", ");
}

function readinessText(readiness: ReadinessRecord): string {
  if (readiness.status === "ready") return "yes";
  return `no: ${readiness.errors.map((issue) => issue.message).join("; ")}`;
}

/** "5 recent: 4 succeeded, 1 failed", the aggregate an agent checks before reading runs. */
function runSummary(runs: readonly { readonly status: string }[]): string {
  if (runs.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  return `${runs.length} recent: ${[...counts].map(([status, count]) => `${count} ${status}`).join(", ")}`;
}

function inspectHelp(detail: AutomationDetailRecord): string[] {
  const help: string[] = [];
  const missing = detail.requiredSecrets.filter((secret) => secret.state !== "bound");
  if (missing.length > 0) {
    help.push(
      `Run \`swizzle secret set ${missing[0]?.name} --value-env <VAR>\`, then \`swizzle apply <dir>\``,
    );
  }
  const lastRun = detail.recentRuns[0];
  if (lastRun !== undefined)
    help.push(`Run \`swizzle logs --run ${lastRun.runId}\` for the last run's logs`);
  help.push(`Run \`swizzle trigger ${detail.automationSlug}\` to start a run`);
  return help;
}

// ---------- resolve ----------

function registerResolve(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("resolve")
    .description("Match a partial name to automation slugs, ranked by confidence")
    .argument("<query>", "Partial name, slug, or display name");
  withExamples(command, ["swizzle resolve report", "swizzle resolve invoice -e production"]);
  command.action(async (query: string, inputOptions: ApiCommandOptions) => {
    await runHandler(async () => {
      const options = await targeted(inputOptions);
      const candidates = await listAutomations(options);
      const matches = rankFuzzyMatches(query, candidates).map((entry) => ({
        name: entry.candidate.automationSlug,
        confidence: Number(entry.score.toFixed(3)),
        kind: entry.score >= 1 ? "exact" : "fuzzy",
      }));
      respond(
        io,
        { query, environment: options.environment, count: matches.length, matches },
        matches.length === 0
          ? ["Run `swizzle list` for every automation in this environment"]
          : ["Run `swizzle inspect <name>` with the matching name"],
      );
    });
  });
}

// ---------- state ----------

function registerState(program: Command, io: CliIO, runHandler: RunHandler): void {
  const state = program
    .command("state")
    .description("Read and change an automation's durable state (small JSON values by key)");
  showsSubcommands(state);
  withExamples(state, [
    "swizzle state list hello-webhook",
    "swizzle state set hello-webhook cursor '{\"page\":2}'",
  ]);

  const list = state
    .command("list")
    .description("List every state key with its value")
    .argument("<automationName>", "Automation name")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(list, [
    "swizzle state list hello-webhook",
    "swizzle state list hello-webhook --json",
  ]);
  list.action(async (automationName: string, inputOptions: TargetOptions) => {
    await runHandler(async () => {
      const options = await targeted(inputOptions);
      const resolved = await resolveAutomationNameOrDie(automationName, options);
      const data = await apiRequest<StateListResponse>(
        buildApiUrl(`/automations/${resolved.slug}/state`, options),
      );
      respond(
        io,
        {
          automation: resolved.slug,
          environment: options.environment,
          ...(data.state.length === 0
            ? { state: "0 keys" }
            : {
                count: data.state.length,
                state: data.state.map((entry) => ({
                  key: entry.key,
                  value: entry.value,
                  updatedAt: entry.updatedAt,
                })),
              }),
        },
        data.state.length === 0
          ? [`Run \`swizzle state set ${resolved.slug} <key> '<json>'\` to store a value`]
          : [],
      );
    });
  });

  const get = state
    .command("get")
    .description("Print one state value; a missing key answers absent")
    .argument("<automationName>", "Automation name")
    .argument("<key>", "State key")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(get, [
    "swizzle state get hello-webhook cursor",
    "swizzle state get hello-webhook seen --json",
  ]);
  get.action(async (automationName: string, key: string, inputOptions: TargetOptions) => {
    await runHandler(async () => {
      const options = await targeted(inputOptions);
      const resolved = await resolveAutomationNameOrDie(automationName, options);
      const data = await apiRequest<StateValueResponse>(
        buildApiUrl(`/automations/${resolved.slug}/state`, options, { key }),
      );
      if (data.state === null) {
        respond(io, { automation: resolved.slug, key, state: "absent: no value under this key" }, [
          `Run \`swizzle state list ${resolved.slug}\` for the keys it has`,
        ]);
        return;
      }
      respond(io, {
        automation: resolved.slug,
        key,
        value: data.state.value,
        updatedAt: data.state.updatedAt,
      });
    });
  });

  const set = state
    .command("set")
    .description("Store a JSON value under a key")
    .argument("<automationName>", "Automation name")
    .argument("<key>", "State key")
    .argument("<json>", "JSON value")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(set, [
    "swizzle state set hello-webhook cursor '{\"page\":2}'",
    "swizzle state set hello-webhook enabled true",
  ]);
  set.action(
    async (automationName: string, key: string, rawJson: string, inputOptions: TargetOptions) => {
      await runHandler(async () => {
        const options = await targeted(inputOptions);
        const resolved = await resolveAutomationNameOrDie(automationName, options);
        const value = parsePayloadJson(rawJson, "inline");
        const data = await apiRequest<SetStateResponse>(
          buildApiUrl(`/automations/${resolved.slug}/state`, options),
          {
            body: JSON.stringify({ key, value }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        respond(io, {
          automation: resolved.slug,
          key,
          value: data.state.value,
          updatedAt: data.state.updatedAt,
        });
      });
    },
  );

  const remove = state
    .command("delete")
    .description("Delete one state key; a missing key is a no-op")
    .argument("<automationName>", "Automation name")
    .argument("<key>", "State key")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(remove, [
    "swizzle state delete hello-webhook cursor",
    "swizzle state delete hello-webhook seen -e production",
  ]);
  remove.action(async (automationName: string, key: string, inputOptions: TargetOptions) => {
    await runHandler(async () => {
      const options = await targeted(inputOptions);
      const resolved = await resolveAutomationNameOrDie(automationName, options, {
        destructive: true,
      });
      const data = await apiRequest<DeleteStateResponse>(
        buildApiUrl(`/automations/${resolved.slug}/state`, options, { key }),
        { method: "DELETE" },
      );
      respond(io, {
        automation: resolved.slug,
        key,
        state: data.deleted ? "deleted" : "already absent (no-op)",
      });
    });
  });
}

// ---------- trigger ----------

function registerTrigger(program: Command, io: CliIO, runHandler: RunHandler): void {
  const trigger = program
    .command("trigger")
    .description(
      "Start a run of a deployed webhook or cron automation; pause or resume its trigger",
    )
    .argument("[automationName]", "Automation name (default: detected from cwd)")
    .option("-p, --payload <json>", "Inline JSON payload")
    .option("-f, --payload-file <path>", "Path to a JSON payload file")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(trigger, [
    'swizzle trigger hello-webhook --payload \'{"name":"Ada"}\'',
    "swizzle trigger hello-webhook --payload-file sample-payload.json -e production",
    "swizzle trigger pause hello-webhook",
  ]);

  trigger.action(
    async (
      automationName: string | undefined,
      inputOptions: TargetOptions & { readonly payload?: string; readonly payloadFile?: string },
    ) => {
      await runHandler(async () => {
        if (inputOptions.payload !== undefined && inputOptions.payloadFile !== undefined) {
          throw new AgentError({
            code: "PAYLOAD_OPTIONS_CONFLICT",
            exitCode: EXIT_CODES.usage,
            hint: "Pass either --payload or --payload-file, not both.",
            message: "--payload and --payload-file were both given.",
          });
        }
        const options = await targeted(inputOptions);
        const resolved = await resolveAutomationNameOrDie(automationName, options);
        let payload: unknown = {};
        if (options.payload !== undefined) {
          payload = parsePayloadJson(options.payload, "inline");
        } else if (options.payloadFile !== undefined) {
          const raw = await readFile(path.resolve(options.payloadFile), "utf8");
          payload = parsePayloadJson(raw, options.payloadFile);
        }

        const result = await apiRequest<TriggerRunResponse>(
          buildApiUrl(`/automations/${resolved.slug}/runs`, options),
          {
            body: JSON.stringify(payload),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        if (result.warning) warn(result.warning);
        respond(
          io,
          {
            run: {
              id: result.runId,
              automation: resolved.slug,
              status: result.status,
              queuedAt: result.queuedAt,
            },
          },
          [
            `Run \`swizzle logs --run ${result.runId} --follow\` to watch it to the end`,
            `Run \`swizzle runs inspect ${result.runId}\` for its status and result`,
          ],
        );
      });
    },
  );

  for (const action of ["pause", "resume"] as const) {
    const sub = trigger
      .command(action)
      .description(
        action === "pause"
          ? "Pause the trigger: cron and webhook stop starting runs; a manual trigger still works"
          : "Resume a paused trigger",
      )
      .argument("[automationName]", "Automation name (default: detected from cwd)")
      .option("--exact", "Disable fuzzy name matching");
    withExamples(sub, [
      `swizzle trigger ${action} hello-webhook`,
      `swizzle trigger ${action} hello-webhook -e production`,
    ]);
    sub.action(async (automationName: string | undefined, inputOptions: TargetOptions) => {
      await runHandler(async () => {
        const options = await targeted(inputOptions);
        const resolved = await resolveAutomationNameOrDie(automationName, options);
        const target = action === "pause" ? "paused" : "active";
        const before = (await listAutomations(options)).find(
          (automation) => automation.automationSlug === resolved.slug,
        )?.trigger?.status;
        const result = await apiRequest<TriggerStatusResponse>(
          buildApiUrl(`/automations/${resolved.slug}/trigger/${action}`, options),
          { method: "POST" },
        );
        respond(io, {
          automation: resolved.slug,
          environment: options.environment,
          trigger: before === target ? `already ${target} (no-op)` : result.status,
        });
      });
    });
  }
}

function rankFuzzyMatches(
  query: string,
  candidates: readonly AutomationSummaryRecord[],
): readonly { readonly candidate: AutomationSummaryRecord; readonly score: number }[] {
  const normalized = query.trim().toLowerCase();
  const results: { candidate: AutomationSummaryRecord; score: number }[] = [];
  for (const candidate of candidates) {
    const slug = candidate.automationSlug.toLowerCase();
    const name = (candidate.automationName ?? "").toLowerCase();
    let score = 0;
    if (slug === normalized || name === normalized) {
      score = 1;
    } else if (slug.startsWith(normalized) || name.startsWith(normalized)) {
      score = 0.9;
    } else if (slug.includes(normalized) || name.includes(normalized)) {
      score = 0.75;
    } else {
      const tokens = normalized.split(/[^a-z0-9]+/i).filter((t) => t.length > 1);
      const candidateTokens = new Set(
        [...slug.split(/[^a-z0-9]+/i), ...name.split(/[^a-z0-9]+/i)].filter((t) => t.length > 1),
      );
      if (tokens.length > 0 && candidateTokens.size > 0) {
        const matched = tokens.filter((t) => candidateTokens.has(t)).length;
        if (matched > 0) score = (matched / tokens.length) * 0.6;
      }
    }
    if (score > 0) results.push({ candidate, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

function parsePayloadJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AgentError({
      code: source === "inline" ? "INVALID_PAYLOAD_JSON" : "INVALID_PAYLOAD_FILE_JSON",
      exitCode: EXIT_CODES.validation,
      hint:
        source === "inline"
          ? "Quote the JSON for your shell, or pass a file with --payload-file."
          : "Fix the JSON file contents or regenerate sample-payload.json.",
      message: `Could not parse payload JSON from ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}
