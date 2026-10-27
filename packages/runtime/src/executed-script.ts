// What one automation process executes and receives. A run executes the entrypoint with its
// payload, state and steps; an API check executes its check script with payload {} and holds no
// state. This module is the one place that knows the difference: the host runner and the
// container runner read an ExecutedScript as it is, without asking which of the two it is.
import type { AutomationWebhookPayloadSchema } from "@swizzle/config";

import { loadPayload, type PayloadInputOptions } from "./payload.js";
import { type AutomationDefinition, activeApiCheck } from "./validation.js";
import type { WebhookRunContext } from "./webhook-context.js";

export interface ExecutedScript {
  /** The script on the host. */
  readonly path: string;
  /** The script inside the automation folder, which the sandbox mounts at /automation. */
  readonly relativePath: string;
  /** The secrets the process requires and receives. */
  readonly secrets: readonly string[];
  /** What the process reads on stdin. */
  readonly payload: unknown;
  /** The schema the payload must match before the process starts. */
  readonly payloadSchema: AutomationWebhookPayloadSchema | undefined;
  /** The state and finished steps the process reads and writes; null when it holds none. */
  readonly persistence: ScriptPersistence | null;
  /** SWIZZLE_TRIGGER_TYPE. */
  readonly triggerType: string;
  readonly webhookContext: WebhookRunContext | null;
}

export interface ScriptPersistence {
  readonly state: Record<string, unknown>;
  readonly steps: Record<string, unknown>;
}

/** A run's inputs: the payload source, the snapshots a deployed run resumes from, its trigger. */
export interface RunInputs extends PayloadInputOptions {
  /** The automation's state; absent for `swizzle run`, which holds no platform state. */
  readonly stateSnapshot?: Record<string, unknown>;
  readonly stepsSnapshot?: Record<string, unknown>;
  /** What started the run. Absent for `swizzle run`, which a person starts by hand: `manual`. */
  readonly triggerType?: string;
  readonly webhookContext?: WebhookRunContext | null;
}

/** The entrypoint with a run's inputs. */
export async function entrypointScript(
  definition: AutomationDefinition,
  inputs: RunInputs,
): Promise<ExecutedScript> {
  const trigger = definition.config.trigger;
  return {
    path: definition.entrypointPath,
    payload: await loadPayload({
      ...(inputs.filePath !== undefined ? { filePath: inputs.filePath } : {}),
      ...(inputs.inlineJson !== undefined ? { inlineJson: inputs.inlineJson } : {}),
      workingDirectory: process.cwd(),
    }),
    payloadSchema: trigger.type === "webhook" ? trigger.payload_schema : undefined,
    persistence:
      inputs.stateSnapshot === undefined
        ? null
        : { state: inputs.stateSnapshot, steps: inputs.stepsSnapshot ?? {} },
    relativePath: definition.entrypointRelativePath,
    secrets: definition.config.secrets,
    triggerType: inputs.triggerType ?? "manual",
    webhookContext: inputs.webhookContext ?? null,
  };
}

/** The API check script: payload {}, the check's own secrets, no state, trigger type `check`. */
export function checkScript(definition: AutomationDefinition): ExecutedScript {
  const check = activeApiCheck(definition);
  return {
    path: check.path,
    payload: {},
    payloadSchema: undefined,
    persistence: null,
    relativePath: check.relativePath,
    secrets: check.secrets,
    triggerType: "check",
    webhookContext: null,
  };
}
