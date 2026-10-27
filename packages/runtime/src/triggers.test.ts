import { parseAutomationConfig } from "@swizzle/config";
import type { ControlPlaneStore, StoredTrigger } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";

import { startManualRun, triggerWebhookByPath } from "./triggers.js";

describe("startManualRun", () => {
  it("refuses a chain automation, which runs only when its sources succeed", async () => {
    const store = {
      getAutomationTriggerBySlug: vi.fn().mockResolvedValue({
        automationId: "automation-1",
        automationName: "hello-chain",
        deploymentId: "deployment-1",
        environment: "local",
        status: "active",
        triggerId: "trigger-1",
        triggerType: "chain",
      }),
    } as unknown as ControlPlaneStore;
    const enqueueRun = vi.fn();

    await expect(
      startManualRun({
        environment: "local",
        automationName: "hello-chain",
        enqueueRun,
        store,
      }),
    ).rejects.toMatchObject({
      code: "TRIGGER_NOT_FIRABLE",
      message: "Automation hello-chain runs when its chain sources succeed, not by hand.",
    });
    expect(enqueueRun).not.toHaveBeenCalled();
  });
});

it("keeps schema rejection audits separate from invalid configuration and enqueue failures", async () => {
  const trigger = {
    automationId: "automation-1",
    automationName: "schema-probe",
    automationSlug: "schema-probe",
    chainOnStatus: null,
    chainPayloadMode: null,
    chainSourceAutomationId: null,
    chainSourceAutomationIds: [],
    config: parseAutomationConfig(`
name: schema-probe
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
  path: /schema-probe
  payload_schema:
    type: object
    required: [event]
`),
    cronIntervalMs: null,
    cronSchedule: null,
    deploymentId: "deployment-1",
    environment: "local",
    errorCode: null,
    errorMessage: null,
    nextRunAt: null,
    pausedAt: null,
    projectId: "project-1",
    status: "active",
    triggerId: "trigger-1",
    triggerType: "webhook",
    updatedAt: "2026-10-27T00:00:00.000Z",
    versionId: "version-1",
    webhookPath: "/schema-probe",
  } satisfies StoredTrigger;
  const createTriggerAuditEvent = vi.fn();
  const getWebhookTriggerByPath = vi.fn().mockResolvedValue(trigger);
  const store = {
    createTriggerAuditEvent,
    getWebhookTriggerByPath,
  } as unknown as ControlPlaneStore;
  const enqueueRun = vi.fn().mockRejectedValue(new Error("queue unavailable"));
  const options = { environment: "local", path: "/schema-probe", store, enqueueRun };

  await expect(triggerWebhookByPath(options)).rejects.toMatchObject({
    code: "WEBHOOK_PAYLOAD_INVALID",
    details: { validationErrors: [expect.objectContaining({ keyword: "required" })] },
  });
  expect(createTriggerAuditEvent.mock.calls.map(([event]) => event.metadata)).toEqual([
    expect.objectContaining({
      reason: "payload-schema-invalid",
      validationErrors: [expect.objectContaining({ keyword: "required" })],
    }),
  ]);

  createTriggerAuditEvent.mockClear();
  getWebhookTriggerByPath.mockResolvedValue({
    ...trigger,
    status: "invalid",
    errorMessage: "bad trigger config",
  });
  await expect(triggerWebhookByPath(options)).rejects.toMatchObject({
    code: "TRIGGER_CONFIGURATION_INVALID",
    message: "bad trigger config",
  });
  expect(createTriggerAuditEvent.mock.calls.map(([event]) => event.metadata)).toEqual([
    expect.objectContaining({ reason: "trigger-invalid" }),
  ]);

  createTriggerAuditEvent.mockClear();
  getWebhookTriggerByPath.mockResolvedValue(trigger);
  await expect(triggerWebhookByPath({ ...options, payload: { event: "created" } })).rejects.toThrow(
    "queue unavailable",
  );
  expect(createTriggerAuditEvent.mock.calls).toEqual([]);

  // A broken stored schema is an internal failure, not a rejected delivery.
  getWebhookTriggerByPath.mockResolvedValue({
    ...trigger,
    config: {
      ...trigger.config,
      trigger: { type: "webhook", path: "/schema-probe", payload_schema: { type: 42 } },
    },
  });
  await expect(triggerWebhookByPath(options)).rejects.toThrow("schema is invalid");
  expect(createTriggerAuditEvent.mock.calls).toEqual([]);
});
