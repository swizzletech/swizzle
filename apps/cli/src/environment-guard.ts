import type { EnvironmentsResponse } from "@swizzle/runtime/http-contract";
import { apiRequest, DEFAULT_API_URL, resolveApiUrl } from "./api.js";
import { responses } from "./api-responses.js";
import type { ApiCommandOptions } from "./command-support.js";
import { AgentError, EXIT_CODES } from "./output.js";
import { loadProfileConfig, resolveEnvironment, resolveProfile } from "./profile.js";

export type EnvironmentLiveness = Pick<
  EnvironmentsResponse["environments"][number],
  "name" | "hasData" | "liveServices"
>;
async function fetchEnvironments(options: ApiCommandOptions) {
  const url = resolveApiUrl(options.apiUrl ?? DEFAULT_API_URL, "/environments").toString();
  return apiRequest(url, responses.environments, { timeoutMs: 5_000 });
}

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
