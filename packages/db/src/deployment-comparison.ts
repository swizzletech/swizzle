import type { AutomationConfig } from "@swizzle/config";
import type { StoredDeployment } from "./control-plane-types/deployments.js";

export interface DeploymentChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

export function isDeploymentUnchanged(
  candidate: Pick<StoredDeployment, "config" | "sourceHash">,
  active: StoredDeployment | null,
): active is StoredDeployment {
  return (
    active !== null &&
    active.sourceHash === candidate.sourceHash &&
    stableStringify(active.config) === stableStringify(candidate.config)
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}

export function deploymentChanges(
  candidate: Pick<StoredDeployment, "config" | "entrypoint" | "sourceHash">,
  active: StoredDeployment | null,
): readonly DeploymentChange[] {
  const { config, sourceHash } = candidate;
  if (!active) {
    return [];
  }

  const changes: DeploymentChange[] = [];
  const candidateTrigger = config.trigger;
  const activeTrigger = active.config.trigger;

  if (sourceHash !== active.sourceHash) {
    changes.push({
      field: "sourceHash",
      from: active.sourceHash,
      to: sourceHash,
    });
  }

  if (config.version !== active.version) {
    changes.push({ field: "version", from: active.version, to: config.version });
  }
  if (candidate.entrypoint !== active.entrypoint) {
    changes.push({
      field: "entrypoint",
      from: active.entrypoint,
      to: candidate.entrypoint,
    });
  }
  if (candidateTrigger.type !== activeTrigger.type) {
    changes.push({ field: "trigger.type", from: activeTrigger.type, to: candidateTrigger.type });
  }
  const activePath = activeTrigger.type === "webhook" ? (activeTrigger.path ?? null) : null;
  const candidatePath =
    candidateTrigger.type === "webhook" ? (candidateTrigger.path ?? null) : null;
  if (candidatePath !== activePath) {
    changes.push({
      field: "trigger.path",
      from: activePath,
      to: candidatePath,
    });
  }

  if (stableStringify(active.config.secrets) !== stableStringify(config.secrets)) {
    changes.push({ field: "secrets", from: active.config.secrets, to: config.secrets });
  }

  const activeVars = active.config.vars;
  if (stableStringify(activeVars) !== stableStringify(config.vars)) {
    changes.push({ field: "vars", from: activeVars, to: config.vars });
  }

  if (
    stableStringify(remainingConfig(config)) !== stableStringify(remainingConfig(active.config))
  ) {
    changes.push({ field: "config", from: active.config, to: config });
  }

  return changes;
}

/** What the specific change rows above have not already described. */
function remainingConfig(config: AutomationConfig) {
  const {
    version: _version,
    entrypoint: _entrypoint,
    secrets: _secrets,
    vars: _vars,
    trigger,
    ...rest
  } = config;
  if (trigger.type === "webhook") {
    const { type: _type, path: _path, ...settings } = trigger;
    return { ...rest, trigger: settings };
  }
  const { type: _type, ...settings } = trigger;
  return { ...rest, trigger: settings };
}
