import { parseAutomationConfig } from "@swizzle/config";
import type { ControlPlaneStore, StoredTrigger } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";

import { startManualRun, triggerWebhookByPath } from "./triggers.js";
import { createWebhookRunContext } from "./webhook-context.js";

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

it("verifies webhook signatures before payload validation and audits input rejections separately from enqueue failures", async () => {
  const configSource = `
name: schema-probe
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
  path: /schema-probe
  payload_schema:
    type: object
    required: [event]
`;
  const trigger = {
    automationId: "automation-1",
    automationName: "schema-probe",
    automationSlug: "schema-probe",
    chainOnStatus: null,
    chainPayloadMode: null,
    chainSourceAutomationId: null,
    chainSourceAutomationIds: [],
    config: parseAutomationConfig(configSource),
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
    boundCredentials: vi
      .fn()
      .mockResolvedValue([{ id: "secret-1", kind: "secret", name: "SIGNING_SECRET" }]),
    createTriggerAuditEvent,
    getWebhookTriggerByPath,
    resolveSecrets: vi.fn().mockResolvedValue([{ value: "signing-key" }]),
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

  getWebhookTriggerByPath.mockResolvedValue({
    ...trigger,
    config: parseAutomationConfig(`${configSource}  signature:
    secret: SIGNING_SECRET
    header: x-signature
    prefix: sha256=
`),
  });
  for (const { headers, signatureReason } of [
    { headers: {}, signatureReason: "signature-header-missing" },
    {
      headers: { "x-signature": `sha256=${"0".repeat(64)}` },
      signatureReason: "signature-mismatch",
    },
  ]) {
    createTriggerAuditEvent.mockClear();
    await expect(
      triggerWebhookByPath({
        ...options,
        payload: {},
        webhookContext: createWebhookRunContext({ headers, rawBody: Buffer.from("{}") }),
      }),
    ).rejects.toMatchObject({ code: "WEBHOOK_NOT_AVAILABLE" });
    expect(createTriggerAuditEvent.mock.calls.map(([event]) => event.metadata)).toEqual([
      expect.objectContaining({ reason: "signature-invalid", signatureReason }),
    ]);
  }

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
