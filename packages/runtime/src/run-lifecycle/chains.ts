import type { ControlPlaneStore } from "@swizzle/db";
import type { PlatformRunRecord, PlatformTriggerRecord } from "../platform-types.js";
import { persistChainJoinRunFromTrigger, persistRunFromTrigger } from "./enqueue.js";

export async function processChainTriggers(input: {
  readonly retryFailures?: boolean;
  readonly run: PlatformRunRecord;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  const chainTriggers = await input.store.getChainTriggersForSource(
    input.run.automationId,
    input.run.environment,
  );

  for (const chainTrigger of chainTriggers) {
    if (chainTrigger.chainSourceAutomationIds.length > 0) {
      await processChainJoinTrigger({
        run: input.run,
        store: input.store,
        trigger: chainTrigger,
        retryFailures: input.retryFailures ?? false,
      });
      continue;
    }

    const matchesStatus =
      chainTrigger.chainOnStatus === "finished" || chainTrigger.chainOnStatus === input.run.status;

    if (!matchesStatus) {
      continue;
    }

    let chainPayload: unknown;
    switch (chainTrigger.chainPayloadMode) {
      case "result":
        chainPayload = input.run.result ?? {};
        break;
      case "payload":
        chainPayload = input.run.payload;
        break;
      case "full":
        chainPayload = {
          source: {
            automationName: input.run.automationName,
            payload: input.run.payload,
            result: input.run.result,
            runId: input.run.runId,
            status: input.run.status,
          },
        };
        break;
      default:
        chainPayload = input.run.result ?? {};
    }

    try {
      await persistRunFromTrigger({
        chainOriginRunId: input.run.runId,
        chainSourceRunIds: [input.run.runId],
        payload: chainPayload,
        store: input.store,
        trigger: chainTrigger,
        triggerType: "chain",
      });
    } catch (error) {
      if (input.retryFailures) throw error;
      // Chain trigger failures must not affect the source run
    }
  }
}

async function processChainJoinTrigger(input: {
  readonly retryFailures?: boolean;
  readonly run: PlatformRunRecord;
  readonly store: ControlPlaneStore;
  readonly trigger: PlatformTriggerRecord;
}): Promise<void> {
  if (input.run.status !== "succeeded") {
    return;
  }

  const originRunId = input.run.chainOriginRunId;
  if (originRunId === null) {
    await input.store.createTriggerAuditEvent({
      automationId: input.trigger.automationId,
      deploymentId: input.trigger.deploymentId,
      environment: input.trigger.environment,
      eventType: "chain_join_skipped",
      metadata: {
        reason: "uncorrelated",
        sourceAutomationName: input.run.automationName,
        sourceRunId: input.run.runId,
      },
      occurredAt: new Date().toISOString(),
      runId: null,
      triggerId: input.trigger.triggerId,
      triggerType: "chain",
    });
    return;
  }

  const sourceRuns = await input.store.findSucceededChainSourceRuns({
    chainOriginRunId: originRunId,
    environment: input.run.environment,
    sourceAutomationIds: input.trigger.chainSourceAutomationIds,
  });
  if (sourceRuns.length < input.trigger.chainSourceAutomationIds.length) {
    return;
  }

  const sourceRunsByAutomationId = new Map(sourceRuns.map((run) => [run.automationId, run]));
  const results: Record<string, unknown> = {};
  const sourceRunIds: Record<string, string> = {};

  for (const sourceAutomationId of input.trigger.chainSourceAutomationIds) {
    const sourceRun = sourceRunsByAutomationId.get(sourceAutomationId);
    if (!sourceRun) {
      return;
    }
    results[sourceRun.automationName] = sourceRun.result ?? {};
    sourceRunIds[sourceRun.automationName] = sourceRun.runId;
  }

  const originRun = await input.store.getRun(originRunId);
  const payload = {
    origin: {
      automation: originRun?.automationName ?? null,
      runId: originRunId,
    },
    results,
  };

  try {
    await persistChainJoinRunFromTrigger({
      originRunId,
      payload,
      sourceRunIds: Object.values(sourceRunIds),
      store: input.store,
      trigger: input.trigger,
    });
  } catch (error) {
    if (input.retryFailures) throw error;
    // Chain trigger failures must not affect the source run.
  }
}
