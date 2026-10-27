/**
 * What `swizzle` with no arguments prints, and what the session hook (`swizzle hooks install`)
 * gives an agent at the start of every session: the binary, what Swizzle is, the target it would
 * act on, and the live state of the directory it runs in. It never fails: an unreachable API or a
 * broken profile is part of the answer, with the command that diagnoses it.
 *
 * In an automation folder it shows that automation; elsewhere the environment's automations and
 * what needs a person, as the dashboard's Overview lists it.
 */
import os from "node:os";
import path from "node:path";

import type {
  AutomationsResponse,
  OverviewResponse as DashboardOverview,
  EnvironmentsResponse,
} from "@swizzle/runtime/http-contract";

import { apiRequest, resolveApiUrl } from "./api.js";
import type { ApiCommandOptions } from "./command-support.js";
import { detectCwdAutomation } from "./context.js";
import { buildEnvironmentNotPinnedError } from "./environment-guard.js";
import { toAgentError } from "./errors.js";
import { type CliIO, type Output, respond } from "./output.js";
import {
  type BearerToken,
  loadProfileConfig,
  resolveEnvironment,
  resolveProfile,
} from "./profile.js";

type DashboardAttentionItem = DashboardOverview["needsYou"][number];

export const DESCRIPTION =
  "Build, deploy and operate code automations on a self-hosted Swizzle instance";

/** The bound on every API call the home view makes, so a session never waits on a dead target. */
const HOME_TIMEOUT_MS = 3_000;

/** Rows the home view lists before it points at `swizzle list`. */
const HOME_ROWS = 10;

export async function renderHome(io: CliIO, options: ApiCommandOptions): Promise<void> {
  const identity = { bin: binPath(), description: DESCRIPTION };
  const folder = await detectCwdAutomation();
  try {
    const target = await resolveTarget(options);
    const state = await liveState(target, folder?.slug);
    respond(io, { ...identity, target: target.shown, ...state.output }, state.help);
  } catch (error) {
    const agentError = toAgentError(error);
    respond(
      io,
      {
        ...identity,
        ...(folder !== undefined ? { folder: { automation: folder.name } } : {}),
        target: `unavailable: ${agentError.message}`,
      },
      [
        "Run `swizzle doctor` to see what is wrong with the target",
        "Run `swizzle profile add <name> --url <api-url> --token-env <VAR>` to target an instance",
        "Run `swizzle init <dir>` to scaffold an automation, `swizzle run <dir>` to run it locally",
      ],
    );
  }
}

/** `~/…` for the executable this process runs, so the agent can tell which install answered. */
function binPath(): string {
  const bin = process.argv[1] ?? "swizzle";
  const home = os.homedir();
  return bin.startsWith(home + path.sep) ? `~${bin.slice(home.length)}` : bin;
}

interface HomeTarget {
  readonly url: string;
  readonly token: BearerToken | null;
  readonly environment: string;
  readonly shown: Output;
}

async function resolveTarget(options: ApiCommandOptions): Promise<HomeTarget> {
  const profile = resolveProfile({
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
    config: await loadProfileConfig(),
  });
  const resolved = resolveEnvironment({
    ...(options.environment !== undefined ? { flag: options.environment } : {}),
    profileEnvironment: profile.environment,
    profileName: profile.name,
  });
  if (resolved.source === "unpinned") {
    const instance = await apiRequest<EnvironmentsResponse>(
      resolveApiUrl(profile.url, "/environments").toString(),
      { timeoutMs: HOME_TIMEOUT_MS, token: profile.token },
    );
    throw await buildEnvironmentNotPinnedError({
      profileName: profile.name,
      options,
      environments: instance.environments,
    });
  }
  const environment = resolved.environment;
  return {
    environment,
    shown: {
      profile: profile.name,
      api: profile.url,
      environment,
      ...(profile.project !== null ? { project: profile.project } : {}),
    },
    token: profile.token,
    url: profile.url,
  };
}

/**
 * Each Needs-you item as one row: what, for which automation, and the command that acts on it in
 * the target's environment. Secrets and connections belong to a project, so their fix names it.
 */
function attentionRow(item: DashboardAttentionItem, env: string) {
  const inspect = (automation: { readonly automationSlug: string }) =>
    `swizzle inspect ${automation.automationSlug} ${env}`;
  switch (item.kind) {
    case "approval":
      return {
        kind: "approval",
        automation: item.automation.automationSlug,
        next: `swizzle runs inspect ${item.runId}`,
      };
    case "failing":
      return {
        kind: `failing (${item.failedRuns} of ${item.recentRuns} runs)`,
        automation: item.automation.automationSlug,
        next: `swizzle diagnose ${item.lastFailedRunId}`,
      };
    case "missing-secret":
      return {
        kind: `missing secret ${item.secretName}`,
        automation: item.usedBy.map((ref) => ref.automationSlug).join(" "),
        next: `swizzle secret set ${item.secretName} --value-env <VAR> --project ${item.project.slug} ${env}`,
      };
    case "missing-connection":
      return {
        kind: `missing connection ${item.connectionName}`,
        automation: item.usedBy.map((ref) => ref.automationSlug).join(" "),
        next: `swizzle connections authorize ${item.connectionName} --project ${item.project.slug} ${env}`,
      };
    case "trigger-invalid":
      return {
        kind: "trigger invalid",
        automation: item.automation.automationSlug,
        next: inspect(item.automation),
      };
    case "api-check":
      return {
        kind: "API check drift",
        automation: item.automation.automationSlug,
        next: inspect(item.automation),
      };
    case "api-sunset":
      return {
        kind: `API sunset ${item.contact.host}`,
        automation: item.automation.automationSlug,
        next: inspect(item.automation),
      };
    case "api-untested":
      return {
        kind: item.host === null ? "API untested" : `API untested ${item.host}`,
        automation: item.automation.automationSlug,
        next: inspect(item.automation),
      };
    case "waiting-for-worker":
      return {
        kind: `${item.queuedRuns} queued: ${item.reason}`,
        automation: item.automation.automationSlug,
        next: `swizzle diagnose ${item.runId}`,
      };
    case "platform":
      return {
        kind: `platform ${item.problem.code}`,
        automation: "(instance)",
        next: `swizzle status ${env}`,
      };
    case "notifications-failed":
      return {
        kind: `${item.failed} notifications failed`,
        automation: "(instance)",
        next: `swizzle notify deliveries ${env}`,
      };
  }
}

async function liveState(
  target: HomeTarget,
  folderSlug: string | undefined,
): Promise<{ readonly output: Output; readonly help: string[] }> {
  const get = <T>(pathname: string) =>
    apiRequest<T>(
      (() => {
        const url = resolveApiUrl(target.url, pathname);
        url.searchParams.set("environment", target.environment);
        return url.toString();
      })(),
      { timeoutMs: HOME_TIMEOUT_MS, token: target.token },
    );
  const [{ automations }, overview] = await Promise.all([
    get<AutomationsResponse>("/dashboard/automations"),
    get<DashboardOverview>("/dashboard/overview"),
  ]);
  const env = `-e ${target.environment}`;

  if (folderSlug !== undefined) {
    const deployed = automations.find((automation) => automation.automationSlug === folderSlug);
    return {
      output: {
        folder: {
          automation: folderSlug,
          deployed:
            deployed?.activeDeployment === undefined
              ? "no"
              : `v${deployed.activeDeployment.version} at ${deployed.activeDeployment.deployedAt}`,
          trigger: deployed?.trigger?.status ?? "none",
          lastRun: deployed?.lastRun?.status ?? "never",
        },
      },
      help: [
        "Run `swizzle run .` to run it locally",
        deployed === undefined
          ? `Run \`swizzle apply . ${env}\` to deploy it`
          : `Run \`swizzle logs ${folderSlug} ${env}\` for its latest run`,
      ],
    };
  }

  const rows = automations.slice(0, HOME_ROWS).map((automation) => ({
    name: automation.automationSlug,
    status: automation.trigger?.status ?? "none",
    lastRun: automation.lastRun?.status ?? "never",
  }));
  const needsYou = overview.needsYou.map((item) => attentionRow(item, env));
  const last24h = Object.entries(overview.last24h)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  return {
    output: {
      count:
        automations.length > rows.length
          ? `${rows.length} of ${automations.length}`
          : automations.length,
      automations: rows,
      runsLast24h: last24h === "" ? "none" : last24h,
      needsYou: needsYou.length > 0 ? needsYou : "nothing waits for you",
    },
    help: [
      ...needsYou.slice(0, 3).map((row) => `Run \`${row.next}\` (${row.kind}, ${row.automation})`),
      ...(automations.length > rows.length
        ? [`Run \`swizzle list ${env}\` for all ${automations.length} automations`]
        : []),
      automations.length === 0
        ? "Run `swizzle init <dir>` to scaffold an automation, then `swizzle apply <dir>`"
        : "Run `swizzle inspect <name>` for one automation",
      "Run `swizzle --help` for every command",
    ],
  };
}
