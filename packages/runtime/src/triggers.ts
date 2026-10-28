import { createHmac, timingSafeEqual } from "node:crypto";
import { scheduler } from "node:timers/promises";
import {
  type AutomationWebhookSignatureConfig,
  normalizeWebhookPath,
  validateWebhookPayloadAgainstSchema,
  type WebhookPayloadValidationIssue,
} from "@swizzle/config";
import { createDisplayName } from "@swizzle/core";
import type { AuditEventOf } from "@swizzle/db";
import {
  type ControlPlaneStore,
  iterateCronOccurrences,
  type RunTriggerType,
  type StoredRun,
  type StoredTrigger,
} from "@swizzle/db";
import { boundCredentialsNamed } from "./deployment-credentials.js";
import { AutomationRuntimeError, getErrorMessage } from "./errors.js";
import { isWebhookDeliveryPath } from "./http-contract.js";

interface TriggerRunEnqueueInput {
  readonly correlationId?: string | null;
  readonly payload: unknown;
  readonly trigger: StoredTrigger;
  readonly triggerType: RunTriggerType;
  readonly webhookContext?: StoredRun["webhookContext"];
}

export type TriggerRunEnqueueFn = (input: TriggerRunEnqueueInput) => Promise<StoredRun>;
export type ManualTriggerRun = StoredRun & { readonly warning?: string };

interface TriggerQueryOptions {
  readonly automationName: string;
  readonly environment: string;
}

export interface ManualRunOptions extends TriggerQueryOptions {
  readonly correlationId?: string | null;
  readonly payload?: unknown;
}

export interface WebhookTriggerByPathOptions {
  readonly correlationId?: string | null;
  readonly environment: string;
  readonly path: string;
  readonly payload?: unknown;
  readonly source?: string;
  readonly webhookContext?: StoredRun["webhookContext"];
}

export interface MaterializeDueCronRunsOptions {
  readonly enqueueRun: TriggerRunEnqueueFn;
  readonly environment: string;
  readonly limit?: number;
  readonly now?: Date;
  readonly store: ControlPlaneStore;
}

export async function getAutomationTrigger(options: {
  readonly automationName: string;
  readonly environment: string;
  readonly store: ControlPlaneStore;
}): Promise<StoredTrigger> {
  const trigger = await options.store.getAutomationTriggerBySlug(
    createDisplayName(options.automationName),
    options.environment,
  );

  if (trigger === null) {
    throw new AutomationRuntimeError(
      "TRIGGER_NOT_FOUND",
      `No trigger found for automation: ${options.automationName}`,
    );
  }

  return trigger;
}

export async function listAutomationTriggerAuditEvents(options: {
  readonly automationName: string;
  readonly environment: string;
  readonly limit?: number;
  readonly store: ControlPlaneStore;
}): Promise<readonly AuditEventOf<"trigger">[]> {
  return await options.store.listTriggerAuditEventsByAutomationSlug(
    createDisplayName(options.automationName),
    options.environment,
    options.limit,
  );
}

export async function pauseAutomationTrigger(options: {
  readonly automationName: string;
  readonly environment: string;
  readonly store: ControlPlaneStore;
}): Promise<StoredTrigger> {
  const trigger = await getAutomationTrigger(options);
  if (trigger.status === "paused") {
    return trigger;
  }

  const updatedAt = new Date().toISOString();
  const updatedTrigger = await options.store.updateAutomationTriggerStatus({
    automationSlug: trigger.automationSlug,
    environment: trigger.environment,
    status: "paused",
    updatedAt,
  });

  if (updatedTrigger === null) {
    throw new AutomationRuntimeError(
      "TRIGGER_NOT_FOUND",
      `No trigger found for automation: ${options.automationName}`,
    );
  }

  await options.store.createTriggerAuditEvent({
    automationId: updatedTrigger.automationId,
    deploymentId: updatedTrigger.deploymentId,
    environment: updatedTrigger.environment,
    eventType: "trigger_paused",
    metadata: {
      status: updatedTrigger.status,
    },
    occurredAt: updatedAt,
    triggerId: updatedTrigger.triggerId,
    triggerType: updatedTrigger.triggerType,
  });

  return updatedTrigger;
}

export async function resumeAutomationTrigger(options: {
  readonly automationName: string;
  readonly environment: string;
  readonly store: ControlPlaneStore;
}): Promise<StoredTrigger> {
  const trigger = await getAutomationTrigger(options);
  if (trigger.status === "active" && trigger.errorCode === null) {
    return trigger;
  }

  const updatedAt = new Date().toISOString();
  const updatedTrigger = await options.store.updateAutomationTriggerStatus({
    automationSlug: trigger.automationSlug,
    environment: trigger.environment,
    status: "active",
    updatedAt,
  });

  if (updatedTrigger === null) {
    throw new AutomationRuntimeError(
      "TRIGGER_NOT_FOUND",
      `No trigger found for automation: ${options.automationName}`,
    );
  }

  await options.store.createTriggerAuditEvent({
    automationId: updatedTrigger.automationId,
    deploymentId: updatedTrigger.deploymentId,
    environment: updatedTrigger.environment,
    eventType: "trigger_resumed",
    metadata: {
      status: updatedTrigger.status,
    },
    occurredAt: updatedAt,
    triggerId: updatedTrigger.triggerId,
    triggerType: updatedTrigger.triggerType,
  });

  return updatedTrigger;
}

/**
 * Starts a run of a webhook or cron automation by hand. The run's trigger type is `manual` and it
 * carries no webhook context, so automation code can tell it from a signed delivery: the caller
 * passed no signature check and sent no sender headers.
 */
export async function startManualRun(
  options: ManualRunOptions & {
    readonly enqueueRun: TriggerRunEnqueueFn;
    readonly store: ControlPlaneStore;
  },
): Promise<ManualTriggerRun> {
  const trigger = await getAutomationTrigger(options);
  if (trigger.triggerType === "chain") {
    throw new AutomationRuntimeError(
      "TRIGGER_NOT_FIRABLE",
      `Automation ${trigger.automationName} runs when its chain sources succeed, not by hand.`,
    );
  }
  const payload = options.payload ?? {};
  const problem = validateTriggerConfiguration(trigger) ?? validateTriggerPayload(trigger, payload);
  if (problem !== null) throw triggerInputError(trigger, problem);
  const run = await options.enqueueRun({
    correlationId: options.correlationId ?? null,
    payload,
    trigger,
    triggerType: "manual",
  });
  return withManualPausedWarning(run, trigger);
}

export async function triggerWebhookByPath(
  options: WebhookTriggerByPathOptions & {
    readonly enqueueRun: TriggerRunEnqueueFn;
    readonly store: ControlPlaneStore;
  },
): Promise<StoredRun> {
  const normalizedPath = normalizeRuntimeWebhookPath(options.path);
  const trigger = await options.store.getWebhookTriggerByPath(normalizedPath, options.environment);

  if (trigger === null) {
    throw new AutomationRuntimeError(
      "TRIGGER_NOT_FOUND",
      `No webhook trigger found for path: ${normalizedPath}`,
    );
  }

  if (trigger.status === "paused") {
    await writeWebhookRejectedAudit(options.store, trigger, {
      reason: "trigger-paused",
      source: options.source ?? "config-webhook-path",
      webhookPath: trigger.webhookPath,
    });
    throw new AutomationRuntimeError(
      "TRIGGER_PAUSED",
      `Trigger is paused for automation: ${trigger.automationName}`,
    );
  }

  const configurationProblem = validateTriggerConfiguration(trigger);
  if (configurationProblem !== null) {
    await rejectWebhookInput(
      options.store,
      trigger,
      options.source ?? "config-webhook-path",
      configurationProblem,
    );
  }
  // Signature is verified BEFORE payload validation: an unsigned or wrongly-signed
  // caller to a signed endpoint must be rejected before any payload-schema feedback
  // (which would otherwise confirm the endpoint exists and leak its schema).
  const signatureValidation = await validateWebhookSignature({
    store: options.store,
    trigger,
    webhookContext: options.webhookContext ?? null,
  });
  if (!signatureValidation.ok) {
    await writeWebhookRejectedAudit(options.store, trigger, {
      reason: "signature-invalid",
      signatureReason: signatureValidation.reason,
      source: options.source ?? "config-webhook-path",
      webhookPath: trigger.webhookPath,
    });
    // The audit event keeps the cause; the caller learns only that no webhook is here.
    throw new AutomationRuntimeError(
      "WEBHOOK_NOT_AVAILABLE",
      `Webhook signature verification failed for automation ${trigger.automationName}.`,
    );
  }
  return await enqueueWebhook({
    correlationId: options.correlationId ?? null,
    enqueueRun: options.enqueueRun,
    payload: options.payload ?? {},
    source: options.source ?? "config-webhook-path",
    store: options.store,
    trigger,
    webhookContext: options.webhookContext ?? null,
  });
}

export async function materializeDueCronRuns(
  options: MaterializeDueCronRunsOptions,
): Promise<readonly StoredRun[]> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const { environment } = options;
  const limit = options.limit ?? 50;
  const runs: StoredRun[] = [];

  while (true) {
    const dueTriggers = await options.store.getDueCronTriggers(nowIso, environment, limit);
    if (dueTriggers.length === 0) {
      return runs;
    }

    let claimedAny = false;

    for (const trigger of dueTriggers) {
      if (trigger.nextRunAt === null) {
        continue;
      }

      let scheduledFor = trigger.nextRunAt;
      let previousDueAt = scheduledFor;
      let dueCount = 1;
      let nextRunAt: string;
      if (trigger.cronIntervalMs !== null) {
        const firstDue = Date.parse(scheduledFor);
        dueCount += Math.floor((now.getTime() - firstDue) / trigger.cronIntervalMs);
        scheduledFor = new Date(firstDue + (dueCount - 1) * trigger.cronIntervalMs).toISOString();
        previousDueAt = new Date(Date.parse(scheduledFor) - trigger.cronIntervalMs).toISOString();
        nextRunAt = new Date(firstDue + dueCount * trigger.cronIntervalMs).toISOString();
      } else if (trigger.cronSchedule !== null) {
        const occurrences = iterateCronOccurrences(trigger.cronSchedule, new Date(scheduledFor));
        nextRunAt = occurrences.next().value;
        while (Date.parse(nextRunAt) <= now.getTime()) {
          previousDueAt = scheduledFor;
          scheduledFor = nextRunAt;
          dueCount++;
          nextRunAt = occurrences.next().value;
          // Long downtime must leave the event loop available for other environments and timers.
          if (dueCount % 1_000 === 0) await scheduler.yield();
        }
      } else {
        continue;
      }
      // Two default scheduler ticks tolerate ordinary polling lag without replaying downtime.
      const withinGrace = now.getTime() - Date.parse(scheduledFor) <= 30_000;
      const missedCount = dueCount - (withinGrace ? 1 : 0);
      const claimed = await options.store.advanceCronTriggerCursor({
        expectedNextRunAt: trigger.nextRunAt,
        ...(missedCount > 0
          ? {
              missed: {
                firstMissedAt: trigger.nextRunAt,
                lastMissedAt: withinGrace ? previousDueAt : scheduledFor,
                missedCount,
              },
            }
          : {}),
        nextRunAt,
        triggerId: trigger.triggerId,
        updatedAt: nowIso,
      });

      if (!claimed) {
        continue;
      }

      claimedAny = true;
      if (!withinGrace) continue;

      const deployment = await options.store.getDeploymentById(trigger.deploymentId);
      const onOverlap = deployment?.config.runtime.on_overlap ?? "skip";
      if (onOverlap === "skip") {
        const activeRunCount = await options.store.countActiveRunsForAutomation(
          trigger.automationId,
          trigger.environment,
        );
        if (activeRunCount > 0) {
          await options.store.createTriggerAuditEvent({
            automationId: trigger.automationId,
            deploymentId: trigger.deploymentId,
            environment: trigger.environment,
            eventType: "cron_skipped",
            metadata: {
              activeRunCount,
              nextRunAt,
              reason: "overlap",
              schedule: trigger.cronSchedule,
              scheduledFor,
            },
            occurredAt: nowIso,
            triggerId: trigger.triggerId,
            triggerType: trigger.triggerType,
          });
          continue;
        }
      }

      try {
        const run = await options.enqueueRun({
          payload: {
            ...(trigger.cronSchedule !== null
              ? { schedule: trigger.cronSchedule }
              : { interval_ms: trigger.cronIntervalMs }),
            scheduled_for: scheduledFor,
            trigger: "cron",
          },
          trigger,
          triggerType: "cron",
        });

        runs.push(run);
      } catch (error) {
        if (
          error instanceof AutomationRuntimeError &&
          error.code === "PLATFORM_REQUIRED_SECRETS_MISSING"
        ) {
          await options.store.createTriggerAuditEvent({
            automationId: trigger.automationId,
            deploymentId: trigger.deploymentId,
            environment: trigger.environment,
            eventType: "cron_skipped",
            metadata: {
              missingSecrets: error.details?.missingSecrets ?? [],
              nextRunAt,
              reason: "missing-secrets",
              schedule: trigger.cronSchedule,
              scheduledFor,
            },
            occurredAt: nowIso,
            triggerId: trigger.triggerId,
            triggerType: trigger.triggerType,
          });
          continue;
        }

        throw error;
      }
    }

    if (!claimedAny || dueTriggers.length < limit) {
      return runs;
    }
  }
}

export function normalizeConfiguredWebhookPath(path: string | undefined): string {
  if (path === undefined) {
    throw new AutomationRuntimeError(
      "TRIGGER_CONFIGURATION_INVALID",
      "Webhook triggers require trigger.path in config.yaml.",
    );
  }

  const normalized = normalizeRuntimeWebhookPath(path);
  if (!isWebhookDeliveryPath(normalized)) {
    throw new AutomationRuntimeError(
      "TRIGGER_CONFIGURATION_INVALID",
      "Webhook paths must not use an API namespace. Use a path under /hooks/.",
    );
  }
  return normalized;
}

function normalizeRuntimeWebhookPath(path: string): string {
  try {
    return normalizeWebhookPath(path);
  } catch (error) {
    throw new AutomationRuntimeError("TRIGGER_CONFIGURATION_INVALID", getErrorMessage(error));
  }
}

type TriggerInputProblem =
  | { readonly kind: "invalid-config"; readonly message: string }
  | { readonly kind: "payload-errors"; readonly errors: readonly WebhookPayloadValidationIssue[] };

function validateTriggerConfiguration(
  trigger: StoredTrigger,
): Extract<TriggerInputProblem, { readonly kind: "invalid-config" }> | null {
  return trigger.status === "invalid"
    ? {
        kind: "invalid-config",
        message: trigger.errorMessage ?? "The trigger configuration is invalid.",
      }
    : null;
}

/** Payload checks follow configuration checks and, for signed deliveries, signature verification. */
function validateTriggerPayload(
  trigger: StoredTrigger,
  payload: unknown,
): Extract<TriggerInputProblem, { readonly kind: "payload-errors" }> | null {
  const validation = validateWebhookPayloadAgainstSchema(
    trigger.config.trigger.type === "webhook" ? trigger.config.trigger.payload_schema : undefined,
    payload,
  );
  return validation.ok ? null : { kind: "payload-errors", errors: validation.errors };
}

function triggerInputError(
  trigger: StoredTrigger,
  problem: TriggerInputProblem,
): AutomationRuntimeError {
  switch (problem.kind) {
    case "invalid-config":
      return new AutomationRuntimeError("TRIGGER_CONFIGURATION_INVALID", problem.message);
    case "payload-errors":
      return new AutomationRuntimeError(
        "WEBHOOK_PAYLOAD_INVALID",
        `Payload for automation ${trigger.automationName} does not match trigger.payload_schema.`,
        { details: { validationErrors: problem.errors } },
      );
  }
}

async function rejectWebhookInput(
  store: ControlPlaneStore,
  trigger: StoredTrigger,
  source: string,
  problem: TriggerInputProblem,
): Promise<never> {
  await writeWebhookRejectedAudit(store, trigger, {
    ...(problem.kind === "invalid-config"
      ? { errorCode: trigger.errorCode, reason: "trigger-invalid" }
      : { reason: "payload-schema-invalid", validationErrors: problem.errors }),
    source,
    webhookPath: trigger.webhookPath,
  });
  throw triggerInputError(trigger, problem);
}

async function enqueueWebhook(options: {
  readonly correlationId?: string | null;
  readonly enqueueRun: TriggerRunEnqueueFn;
  readonly payload: unknown;
  readonly source: string;
  readonly store: ControlPlaneStore;
  readonly trigger: StoredTrigger;
  readonly webhookContext?: StoredRun["webhookContext"];
}): Promise<StoredRun> {
  const problem = validateTriggerPayload(options.trigger, options.payload);
  if (problem !== null) {
    await rejectWebhookInput(options.store, options.trigger, options.source, problem);
  }

  try {
    const run = await options.enqueueRun({
      correlationId: options.correlationId ?? null,
      payload: options.payload,
      trigger: options.trigger,
      triggerType: "webhook",
      webhookContext: options.webhookContext ?? null,
    });

    return run;
  } catch (error) {
    if (
      error instanceof AutomationRuntimeError &&
      error.code === "PLATFORM_REQUIRED_SECRETS_MISSING"
    ) {
      await writeWebhookRejectedAudit(options.store, options.trigger, {
        missingSecrets: error.details?.missingSecrets ?? [],
        reason: "missing-secrets",
        source: options.source,
        webhookPath: options.trigger.webhookPath,
      });
    }

    throw error;
  }
}

async function validateWebhookSignature(input: {
  readonly store: ControlPlaneStore;
  readonly trigger: StoredTrigger;
  readonly webhookContext: StoredRun["webhookContext"];
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (input.trigger.config.trigger.type !== "webhook") {
    return { ok: true };
  }

  const signature = input.trigger.config.trigger.signature;
  if (signature === undefined) {
    return { ok: true };
  }

  if (input.webhookContext === null) {
    return { ok: false, reason: "raw-body-missing" };
  }

  const { bound } = await boundCredentialsNamed({
    holder: input.trigger,
    kind: "secret",
    names: [signature.secret],
    store: input.store,
  });
  const [secret] = await input.store.resolveSecrets(bound.map((credential) => credential.id));
  if (secret === undefined) {
    return { ok: false, reason: "signature-secret-missing" };
  }

  const headerName = signature.header.toLowerCase();
  const headerValue = input.webhookContext.headers[headerName];
  if (headerValue === undefined || headerValue.trim().length === 0) {
    return { ok: false, reason: "signature-header-missing" };
  }

  const providedSignature = extractProvidedSignature(headerValue, signature);
  if (providedSignature === null) {
    return { ok: false, reason: "signature-prefix-missing" };
  }

  const expectedSignature = createHmac("sha256", secret.value)
    .update(Buffer.from(input.webhookContext.rawBodyBase64, "base64"))
    .digest(signature.encoding);

  if (!timingSafeStringEqual(providedSignature, expectedSignature)) {
    return { ok: false, reason: "signature-mismatch" };
  }

  return { ok: true };
}

function extractProvidedSignature(
  headerValue: string,
  signature: AutomationWebhookSignatureConfig,
): string | null {
  const values = headerValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (signature.prefix.length === 0) {
    return values[0] ?? null;
  }

  const matchingValue = values.find((value) => value.startsWith(signature.prefix));
  return matchingValue?.slice(signature.prefix.length).trim() ?? null;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function withManualPausedWarning(run: StoredRun, trigger: StoredTrigger): ManualTriggerRun {
  if (trigger.status !== "paused") return run;
  return {
    ...run,
    warning: "trigger is paused; this manual run executed anyway; scheduled firing remains paused",
  };
}

async function writeWebhookRejectedAudit(
  store: ControlPlaneStore,
  trigger: StoredTrigger,
  metadata: Record<string, unknown>,
): Promise<void> {
  await store.createTriggerAuditEvent({
    automationId: trigger.automationId,
    deploymentId: trigger.deploymentId,
    environment: trigger.environment,
    eventType: "webhook_rejected",
    metadata,
    occurredAt: new Date().toISOString(),
    triggerId: trigger.triggerId,
    triggerType: trigger.triggerType,
  });
}
