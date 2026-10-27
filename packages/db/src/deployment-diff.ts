import type { DeploymentDiff } from "./audit.js";
import type { StoredDeployment } from "./control-plane-types.js";

/** Compares a deployment with the one it replaces; with no previous deployment every `*Changed` flag is false. */
export function computeDeploymentDiff(
  current: StoredDeployment,
  previous: StoredDeployment | null,
): DeploymentDiff {
  const prevConfig = previous?.config;
  const prevRuntime = previous?.runtimeSnapshot;
  return {
    entrypointChanged: previous !== null && current.entrypoint !== previous.entrypoint,
    executionMode: current.runtimeSnapshot.execution_mode,
    executionModeChanged:
      previous !== null && current.runtimeSnapshot.execution_mode !== prevRuntime?.execution_mode,
    language: current.runtimeSnapshot.language,
    languageChanged:
      previous !== null && current.runtimeSnapshot.language !== prevRuntime?.language,
    previousEntrypoint: previous?.entrypoint ?? null,
    previousExecutionMode: prevRuntime?.execution_mode ?? null,
    previousLanguage: prevRuntime?.language ?? null,
    previousProfile: prevRuntime?.profile ?? null,
    previousRequirements: prevRuntime?.requirements ?? null,
    previousSecrets: prevConfig?.secrets ? [...prevConfig.secrets] : [],
    previousVars: { ...(prevConfig?.vars ?? {}) },
    previousTriggerType: prevConfig?.trigger.type ?? null,
    previousVersion: previous?.version ?? null,
    profile: current.runtimeSnapshot.profile,
    profileChanged: previous !== null && current.runtimeSnapshot.profile !== prevRuntime?.profile,
    requirements: current.runtimeSnapshot.requirements,
    requirementsChanged:
      previous !== null &&
      JSON.stringify(current.runtimeSnapshot.requirements) !==
        JSON.stringify(prevRuntime?.requirements ?? null),
    secrets: [...current.config.secrets],
    secretsAdded: current.config.secrets.filter((secret) => !prevConfig?.secrets.includes(secret)),
    secretsRemoved:
      prevConfig?.secrets.filter((secret) => !current.config.secrets.includes(secret)) ?? [],
    sourceHashChanged: previous !== null && current.sourceHash !== previous.sourceHash,
    triggerType: current.config.trigger.type,
    triggerTypeChanged:
      previous !== null && current.config.trigger.type !== prevConfig?.trigger.type,
    version: current.version,
    versionChanged: previous !== null && current.version !== previous.version,
    vars: { ...current.config.vars },
    varsChanged:
      previous !== null &&
      JSON.stringify(current.config.vars) !== JSON.stringify(prevConfig?.vars ?? {}),
  };
}
