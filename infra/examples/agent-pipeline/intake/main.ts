#!/usr/bin/env node
import { runAutomation } from "./swizzle-sdk.ts";

type WorkOrderPayload = {
  readonly repoUrl?: string;
  readonly baseBranch?: string;
  readonly specRef?: string;
  readonly options?: Readonly<Record<string, unknown>>;
};

type WorkOrder = {
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly specRef: string;
  readonly options: Readonly<Record<string, unknown>>;
};

await runAutomation<WorkOrderPayload, WorkOrder>(async ({ payload, logStep }) => {
  const workOrder = normalizeWorkOrder(payload);

  logStep("accepted decision-complete work order", {
    baseBranch: workOrder.baseBranch,
    optionKeys: Object.keys(workOrder.options).sort(),
    repoUrl: workOrder.repoUrl,
    specRef: workOrder.specRef,
  });

  return workOrder;
});

function normalizeWorkOrder(payload: WorkOrderPayload): WorkOrder {
  const options = payload.options ?? {};
  if (!isRecord(options) || Array.isArray(options)) {
    throw new Error("intake expected options to be an object when provided.");
  }

  return {
    baseBranch: requireText(payload.baseBranch, "baseBranch"),
    options,
    repoUrl: requireText(payload.repoUrl, "repoUrl"),
    specRef: requireText(payload.specRef, "specRef"),
  };
}

function requireText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new Error(`intake expected ${field} to be a non-empty string.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
