import { describe, expect, it } from "vitest";
import { testAuditStore } from "../../../test/stores.js";
import type { RecordAuditChange } from "./audit.js";
import { NO_AUDIT_TARGET } from "./audit.js";
import { auditScope } from "./audit-context.js";

function pausedTrigger(): RecordAuditChange {
  return {
    occurredAt: "2026-10-25T08:00:00.000Z",
    actor: {
      kind: "worker",
      workerId: "00000000-0000-4000-8000-000000000011",
      label: "Office worker",
    },
    change: {
      kind: "trigger",
      automationId: "00000000-0000-4000-8000-000000000012",
      automationName: "Export",
      automationSlug: "export",
      deploymentId: "d2997a2b-6e5f-5f77-9b86-66feb65ab00e",
      environment: "staging",
      eventType: "trigger_paused",
      projectId: "00000000-0000-4000-8000-000000000013",
      runId: null,
      triggerId: "bc8d754d-e8f1-5d8e-bc26-12cd68e6d976",
      triggerType: "webhook",
      metadata: { reason: "Maintenance" },
    },
  };
}
const ALL = { environments: null, projectIds: null, limit: null } as const;

describe("audit ownership", () => {
  it("isolates stored history from input and returned objects", async () => {
    const store = testAuditStore();
    const input = pausedTrigger();
    await store.record(input);
    const [read] = await store.list(ALL);
    if (read?.change?.kind !== "trigger") throw new Error("Missing trigger history");
    read.change.metadata.reason = "Changed through a read";
    Object.assign(read.actor, { label: "Changed actor" });
    expect(await store.list(ALL)).toMatchObject([
      {
        actor: { kind: "worker", label: "Office worker" },
        change: {
          kind: "trigger",
          metadata: { reason: "Maintenance" },
        },
      },
    ]);
    if (input.change.kind !== "trigger") throw new Error("Missing trigger input");
    input.change.metadata.reason = "Changed after recording";
    expect(await store.list(ALL)).toMatchObject([
      {
        change: {
          kind: "trigger",
          metadata: { reason: "Maintenance" },
        },
      },
    ]);
  });

  it("keeps the first change and refuses another change in the same request", async () => {
    const store = testAuditStore();
    await auditScope.run(
      { eventId: null, actor: { kind: "system" }, requestId: "one-change" },
      async () => {
        await store.record(pausedTrigger());
        await expect(store.record(pausedTrigger())).rejects.toThrow("already has a change");
      },
    );
    expect(await store.list(ALL)).toMatchObject([
      { requestId: "one-change", change: { metadata: { reason: "Maintenance" } } },
    ]);
    expect((await store.list(ALL)).length).toBe(1);
  });

  it("refuses to enrich a request after it finished", async () => {
    const store = testAuditStore();
    const id = await store.begin({
      action: "POST /change",
      actor: { kind: "system" },
      details: null,
      params: {},
      privileged: false,
      requestId: "request",
      target: NO_AUDIT_TARGET,
    });
    await store.finish(id, 200);
    await auditScope.run(
      { eventId: id, actor: { kind: "system" }, requestId: "request" },
      async () => {
        await expect(store.record(pausedTrigger())).rejects.toThrow(
          "The request audit event is missing, finished or already has a change.",
        );
      },
    );
    expect(await store.list(ALL)).toMatchObject([
      { id, action: "POST /change", status: 200, change: null },
    ]);
  });
});
