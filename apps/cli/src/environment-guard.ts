import type { EnvironmentsResponse } from "@swizzle/runtime/http-contract";
import { apiRequest, resolveApiUrl } from "./api.js";
import { type ApiCommandOptions, DEFAULT_API_URL } from "./command-support.js";
import { AgentError, EXIT_CODES } from "./output.js";
import { loadProfileConfig, resolveEnvironment, resolveProfile } from "./profile.js";

// Scheduler heartbeats describe the namespaces the instance serves. Warn when a target has
// no live heartbeat, for example while an older scheduler is still running during an upgrade.

export type EnvironmentLiveness = Pick<
  EnvironmentsResponse["environments"][number],
  "name" | "hasData" | "liveServices"
>;
type InstanceEnvironments = {
  readonly environments: readonly EnvironmentLiveness[];
};

/** Parse environment choices and scheduler liveness for the command's hints. */
async function fetchEnvironments(options: ApiCommandOptions): Promise<InstanceEnvironments> {
  const url = resolveApiUrl(options.apiUrl ?? DEFAULT_API_URL, "/environments").toString();
  const response = await apiRequest<unknown>(url, { timeoutMs: 5_000 });
  const invalid = () =>
    new AgentError({
      code: "API_RESPONSE_INVALID",
      message: `The API at ${url} returned invalid environment information.`,
      exitCode: EXIT_CODES.backend,
      fixCommand: "swizzle doctor",
      hint: "The URL may point at something other than a Swizzle API; check --api-url or the profile.",
    });
  if (
    typeof response !== "object" ||
    response === null ||
    !("environments" in response) ||
    !Array.isArray(response.environments)
  )
    throw invalid();
  const environments = response.environments.map((entry: unknown): EnvironmentLiveness => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      !("hasData" in entry) ||
      typeof entry.hasData !== "boolean" ||
      !("liveServices" in entry) ||
      !Array.isArray(entry.liveServices) ||
      !entry.liveServices.every((service: unknown) => typeof service === "string")
    )
      throw invalid();
    return { name: entry.name, hasData: entry.hasData, liveServices: entry.liveServices };
  });
  return { environments };
}

/** Resolve a command's target explicitly; an optional observer shares the same instance response. */
export async function resolveCommandEnvironment(
  options: ApiCommandOptions,
  inspect?: (environment: string, environments: readonly EnvironmentLiveness[]) => void,
): Promise<string> {
  const profile = resolveProfile({
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    config: await loadProfileConfig(),
  });
  const resolved = resolveEnvironment({
    ...(options.environment !== undefined ? { flag: options.environment } : {}),
    profileEnvironment: profile.environment,
    profileName: profile.name,
  });
  if (resolved.environment !== null && inspect === undefined) return resolved.environment;
  const instance = await fetchEnvironments(options);
  if (resolved.source === "unpinned") {
    throw await buildEnvironmentNotPinnedError({
      profileName: profile.name,
      options,
      environments: instance.environments,
    });
  }
  const environment = resolved.environment;
  inspect?.(environment, instance.environments);
  return environment;
}

/**
 * Build the "no scheduler fires this environment's cron triggers" warning, or `null` when no
 * warning is warranted.
 *
 * - `deploy`: the caller applied a cron automation; warn whenever the target environment has no
 *   live scheduler. A first-time setup legitimately deploys before the scheduler runs, so this is
 *   advisory only.
 * - `status`: warn only for the *misleading* case: the target has data but no live scheduler
 *   while some *other* environment has one. A wholesale outage (no scheduler anywhere) is not
 *   misdirection, so we stay quiet and let the normal degraded state speak for itself.
 */
export function buildUnservedEnvironmentWarning(input: {
  readonly mode: "deploy" | "status";
  readonly environment: string;
  readonly environments: readonly EnvironmentLiveness[];
}): string | null {
  const target = input.environments.find((entry) => entry.name === input.environment);
  if (target?.liveServices.includes("scheduler") === true) {
    return null;
  }

  const othersWithScheduler = input.environments
    .filter((entry) => entry.name !== input.environment && entry.liveServices.includes("scheduler"))
    .map((entry) => entry.name)
    .sort();

  if (input.mode === "status") {
    const hasData = target?.hasData === true;
    if (!hasData || othersWithScheduler.length === 0) {
      return null;
    }
  }

  const suggestion =
    othersWithScheduler.length > 0
      ? ` Environments with a live scheduler: ${othersWithScheduler.join(", ")}. Deploy with -e ${othersWithScheduler[0]} if that was the target.`
      : "";
  return `No live scheduler heartbeat for environment "${input.environment}" on this instance, so its cron triggers will not fire.${suggestion}`;
}

/**
 * Build the error raised when a named profile targets a specific instance but
 * pins no environment. The same instance response supplies available names and live schedulers
 * for the hint. Lookup errors propagate to the command.
 */
export async function buildEnvironmentNotPinnedError(input: {
  readonly profileName: string;
  readonly options: ApiCommandOptions;
  readonly environments?: readonly EnvironmentLiveness[] | undefined;
}): Promise<AgentError> {
  const environments = input.environments ?? (await fetchEnvironments(input.options)).environments;
  const available = environments.map((entry) => entry.name);
  const withSchedulers = environments
    .filter((entry) => entry.liveServices.includes("scheduler"))
    .map((entry) => entry.name);

  const availabilityHint =
    available.length > 0
      ? ` Available environments on this instance: ${available.join(", ")}${
          withSchedulers.length > 0 ? ` (live schedulers: ${withSchedulers.join(", ")})` : ""
        }.`
      : "";

  return new AgentError({
    code: "ENVIRONMENT_NOT_PINNED",
    message: `Profile "${input.profileName}" targets a specific instance but no environment is pinned. Refusing to guess one.`,
    hint: `Pin the environment one of two ways: re-add the profile with --env (swizzle profile add ${input.profileName} --url <url> --env <env>), or pass -e <env> on the command.${availabilityHint}`,
    retryable: false,
    exitCode: EXIT_CODES.validation,
    details: {
      profile: input.profileName,
      ...(available.length > 0 ? { availableEnvironments: available } : {}),
      ...(withSchedulers.length > 0 ? { environmentsWithLiveSchedulers: withSchedulers } : {}),
    },
  });
}
