import type { AutomationWebhookPayloadSchema } from "@swizzle/config";

import { loadPayload, type PayloadInputOptions } from "./payload.js";
import { type AutomationDefinition, activeApiCheck } from "./validation.js";
import type { WebhookRunContext } from "./webhook-context.js";

export interface ExecutedScript {
  readonly path: string;
  readonly relativePath: string;
  readonly secrets: readonly string[];
  readonly payload: unknown;
  readonly payloadSchema: AutomationWebhookPayloadSchema | undefined;
  readonly persistence: ScriptPersistence | null;
  readonly triggerType: string;
  readonly webhookContext: WebhookRunContext | null;
}

export interface ScriptPersistence {
  readonly state: Record<string, unknown>;
  readonly steps: Record<string, unknown>;
}

export interface RunInputs extends PayloadInputOptions {
  readonly stateSnapshot?: Record<string, unknown>;
  readonly stepsSnapshot?: Record<string, unknown>;
  readonly triggerType?: string;
  readonly webhookContext?: WebhookRunContext | null;
}

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
