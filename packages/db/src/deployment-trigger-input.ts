import { normalizeWebhookPath, parseIntervalToMs } from "@swizzle/config";
import { createDisplayName } from "@swizzle/core";
import { CronExpressionParser } from "cron-parser";
import { CodedError } from "./coded-error.js";
import type { DeploymentTriggerInput, StoredDeployment } from "./control-plane-types.js";

export interface DeploymentTriggerLookup {
  readonly getActiveDeploymentBySlug: (
    slug: string,
    environment: string,
  ) => Promise<{ readonly automationId: string; readonly projectId: string } | null>;
  readonly getChainTriggersForSource: (
    sourceAutomationId: string,
    environment: string,
  ) => Promise<readonly { readonly automationId: string }[]>;
}

/** The parts of a deployment its trigger row derives from. */
export type TriggerDeployment = Pick<
  StoredDeployment,
  "automationId" | "projectId" | "deployedAt" | "deploymentId" | "environment" | "versionId"
> & { readonly config: Pick<StoredDeployment["config"], "trigger"> };

export async function buildDeploymentTriggerInput(
  deployment: TriggerDeployment,
  lookup: DeploymentTriggerLookup,
): Promise<DeploymentTriggerInput> {
  const deployedAt = new Date(deployment.deployedAt);
  const trigger = deployment.config.trigger;
  const base = {
    automationId: deployment.automationId,
    deploymentId: deployment.deploymentId,
    environment: deployment.environment,
    updatedAt: deployedAt.toISOString(),
    versionId: deployment.versionId,
  };

  if (trigger.type === "webhook") {
    return { ...base, triggerType: "webhook", webhookPath: normalizeWebhookPath(trigger.path) };
  }

  if (trigger.type === "chain") {
    const sourceDeployments = await resolveChainSources(
      deployment,
      lookup.getActiveDeploymentBySlug,
    );
    const invalidChain = (errorMessage: string): DeploymentTriggerInput => ({
      ...base,
      triggerType: "chain",
      chainOnStatus: null,
      chainPayloadMode: null,
      chainSourceAutomationId: null,
      chainSourceAutomationIds: [],
      errorCode: "TRIGGER_CONFIGURATION_INVALID",
      errorMessage,
    });
    const downstream = await collectDownstreamAutomationIds(deployment, lookup);
    const cycleSource = sourceDeployments.find((source) =>
      downstream.has(source.deployment.automationId),
    );
    if (cycleSource !== undefined) {
      return invalidChain(
        `Chain trigger would create a cycle through source automation: ${cycleSource.name}`,
      );
    }
    const isJoin = sourceDeployments.length > 1;
    return {
      ...base,
      triggerType: "chain",
      chainOnStatus: trigger.on,
      chainPayloadMode: trigger.payload,
      chainSourceAutomationId: isJoin
        ? null
        : (sourceDeployments[0]?.deployment.automationId ?? null),
      chainSourceAutomationIds: isJoin
        ? sourceDeployments.map((source) => source.deployment.automationId)
        : [],
    };
  }

  const schedule = trigger.schedule?.trim() || null;
  const every = trigger.every?.trim();
  if (!every && schedule === null) {
    return {
      ...base,
      triggerType: "cron",
      cronIntervalMs: null,
      cronSchedule: null,
      nextRunAt: null,
      errorCode: "TRIGGER_CRON_SCHEDULE_MISSING",
      errorMessage:
        "Cron triggers require trigger.schedule (cron expression) or trigger.every (interval like 5m) in config.yaml.",
    };
  }
  try {
    const intervalMs = every ? parseIntervalToMs(every) : null;
    return {
      ...base,
      triggerType: "cron",
      cronIntervalMs: intervalMs,
      cronSchedule: schedule,
      nextRunAt:
        intervalMs !== null
          ? new Date(deployedAt.getTime() + intervalMs).toISOString()
          : getNextCronOccurrence(schedule ?? "", deployedAt),
    };
  } catch (error) {
    return {
      ...base,
      triggerType: "cron",
      cronIntervalMs: null,
      cronSchedule: schedule,
      nextRunAt: null,
      errorCode: "TRIGGER_CRON_SCHEDULE_INVALID",
      errorMessage:
        error instanceof Error ? error.message : "Cron trigger schedule could not be parsed.",
    };
  }
}

/** Refuse absent and other-project sources identically before their config is published. */
export async function resolveChainSources(
  deployment: Pick<TriggerDeployment, "config" | "environment" | "projectId">,
  lookup: DeploymentTriggerLookup["getActiveDeploymentBySlug"],
): Promise<
  readonly { readonly deployment: { readonly automationId: string }; readonly name: string }[]
> {
  const trigger = deployment.config.trigger;
  if (trigger.type !== "chain") return [];
  const sources = [];
  for (const name of trigger.sources ?? (trigger.source ? [trigger.source] : [])) {
    const source = await lookup(createDisplayName(name), deployment.environment);
    if (source === null || source.projectId !== deployment.projectId) {
      throw new CodedError(
        "TRIGGER_CONFIGURATION_INVALID",
        `Chain source automation not found: ${name}`,
      );
    }
    sources.push({ deployment: source, name });
  }
  return sources;
}

/**
 * The automations the deployed one triggers through active chains, directly or transitively, and
 * itself. A source in this set would close a cycle.
 */
async function collectDownstreamAutomationIds(
  deployment: TriggerDeployment,
  lookup: DeploymentTriggerLookup,
): Promise<ReadonlySet<string>> {
  const reached = new Set([deployment.automationId]);
  for (const automationId of reached) {
    for (const trigger of await lookup.getChainTriggersForSource(
      automationId,
      deployment.environment,
    )) {
      reached.add(trigger.automationId);
    }
  }
  return reached;
}

export function getNextCronOccurrence(schedule: string, from: Date): string {
  return CronExpressionParser.parse(schedule, { currentDate: from, tz: "UTC" })
    .next()
    .toDate()
    .toISOString();
}
