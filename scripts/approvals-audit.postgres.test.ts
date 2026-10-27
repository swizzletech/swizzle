import { it } from "vitest";
import { testDatabase } from "../test/postgres.js";
import { testControlPlaneStore } from "../test/stores.js";
// Assigned approvals, the audit and per-person notifications on PostgreSQL: of two decisions
// racing for one wait exactly one commits its step result,
// a reassignment lands only on the assignee it expects, an assignee resolves by email or team
// name, a person's read access answers a notification send, and audit events outlive the
// automation they name.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  type ApprovalAssignee,
  auditScope,
  type ControlPlaneStore,
  NO_AUDIT_TARGET,
} from "@swizzle/db";
import {
  createPostgresAccessStore,
  createPostgresAuditStore,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { commitDeploymentFixture, createQueuedRun } from "./verify-state-fixtures.js";

async function verifyApprovalsAndAudit(
  client: DatabaseClient,
  store: ControlPlaneStore,
): Promise<void> {
  const access = createPostgresAccessStore({ client });
  const person = async (email: string) => {
    const { rows } = await client.pool.query<{ id: string }>(
      "INSERT INTO auth_users (name, email, role) VALUES ($1, $2, 'member') RETURNING id",
      [email, email],
    );
    return rows[0]?.id ?? assert.fail("person row");
  };
  const ada = await person("Ada@Approvals.Verify");
  const project = await access.createProject({ name: "Approvals", slug: "approvals-verify" });
  const deployment = await commitDeploymentFixture(store, "approvals-verify", project.id);
  const target = {
    automationId: deployment.automationId,
    environment: deployment.environment,
    projectId: project.id,
  };

  // An assignee resolves by email in any case, or by team name.
  const team = await access.createTeam("Approvals Crew");
  await access.setTeamMember(team.id, ada, true);
  assert.deepEqual(await store.resolveApprovalAssignee({ user: "ada@approvals.verify" }), {
    kind: "user",
    label: "Ada@Approvals.Verify",
    userId: ada,
  });
  const crew = await store.resolveApprovalAssignee({ team: "approvals crew" });
  assert.deepEqual(crew, { kind: "team", label: "Approvals Crew", teamId: team.id });
  assert.equal(await store.resolveApprovalAssignee({ user: "nobody@approvals.verify" }), null);
  if (crew === null) return;

  // Of two decisions racing for the same wait, one commits; the step result is the winner's.
  const runId = await waitingApproval(store, deployment, crew);
  const decide = (label: string) =>
    store.resumeWaitingRun({
      expectedAssignee: crew,
      expectedWaitReason: "approval",
      result: {
        approval: {
          approved: true,
          assignee: crew,
          comment: label,
          decidedAt: new Date().toISOString(),
          decidedBy: { kind: "person", label, userId: ada },
          timedOut: false,
        },
      },
      runId,
      stepKey: "gate",
    });
  const outcomes = await Promise.all(["first", "second", "third"].map(decide));
  assert.equal(outcomes.filter((outcome) => outcome !== null).length, 1, "one decision lands");
  const steps = await store.listRunSteps({ runId });
  assert.equal(steps.length, 1);
  const landed = outcomes.findIndex((outcome) => outcome !== null);
  assert.equal(
    (steps[0]?.approval as { comment?: string } | null)?.comment,
    ["first", "second", "third"][landed],
    "the step result names the decision that landed",
  );

  // A reassignment lands only on the assignee it expects; a decision for the old one then fails.
  const reassigned = await waitingApproval(store, deployment, crew);
  const adaAlone: ApprovalAssignee = { kind: "user", label: "Ada", userId: ada };
  assert.equal(
    await store.reassignApproval({ from: null, runId: reassigned, stepKey: "gate", to: adaAlone }),
    false,
  );
  assert.equal(
    await store.reassignApproval({ from: crew, runId: reassigned, stepKey: "gate", to: adaAlone }),
    true,
  );
  const reassignedWait = (await store.getRun(reassigned))?.wait;
  assert.equal(reassignedWait?.reason, "approval");
  assert.equal(
    reassignedWait?.reason === "approval" ? reassignedWait.assignee?.kind : null,
    "user",
  );
  assert.equal(
    await store.resumeWaitingRun({
      expectedAssignee: crew,
      expectedWaitReason: "approval",
      result: { value: null },
      runId: reassigned,
      stepKey: "gate",
    }),
    null,
  );

  // Read access answers a notification send: granted, revoked, then suspended.
  assert.equal(await store.personMayRead(ada, target), false);
  await access.setGrant(
    { kind: "team", teamId: team.id },
    { on: "project", projectId: project.id, role: "viewer" },
  );
  assert.equal(await store.personMayRead(ada, target), true, "a team grant reaches a member");
  await access.setTeamMember(team.id, ada, false);
  assert.equal(await store.personMayRead(ada, target), false, "leaving the team revokes it");
  await access.setTeamMember(team.id, ada, true);
  await client.pool.query("UPDATE auth_users SET suspended_at = now() WHERE id = $1", [ada]);
  assert.equal(await store.personMayRead(ada, target), false, "a suspended person reads nothing");

  // A rule belongs to its person and goes with them.
  const rule = await store.createNotificationRule({
    automationId: null,
    channel: "telegram",
    chatId: "-1003",
    cooldownSeconds: 900,
    environment: deployment.environment,
    eventType: "dead-lettered",
    projectId: project.id,
    threshold: 1,
    userId: ada,
    windowSeconds: 3600,
  });
  assert.deepEqual(
    (
      await store.listNotificationRules({
        automation: { automationId: deployment.automationId, projectId: project.id },
        environment: deployment.environment,
      })
    ).map((listed) => listed.ruleId),
    [rule.ruleId],
    "a project rule covers the project's automations",
  );

  // Audit events outlive the automation they name.
  const audit = createPostgresAuditStore({ client });
  const actor = {
    kind: "person",
    label: "Ada",
    role: "member",
    tokenId: null,
    userId: ada,
  } as const;
  const eventId = await audit.begin({
    action: "POST /runs/:runId/approvals/:stepKey",
    actor,
    details: null,
    params: { runId, stepKey: "gate" },
    privileged: false,
    requestId: "verify-1",
    target: {
      automationId: deployment.automationId,
      automationSlug: "approvals-verify",
      environment: deployment.environment,
      projectId: project.id,
      runId,
    },
  });
  // What a route learns is durable before its change runs, and a later fact keeps a known target.
  await audit.describe(eventId, {
    details: { reason: "verify" },
    privileged: false,
    target: NO_AUDIT_TARGET,
  });
  await audit.finish(eventId, 200);
  await client.pool.query(
    "UPDATE runs SET status = 'succeeded', finished_at = now() WHERE automation_id = $1",
    [deployment.automationId],
  );
  await store.updateAutomationTriggerStatus({
    automationSlug: "approvals-verify",
    environment: deployment.environment,
    status: "paused",
    updatedAt: new Date().toISOString(),
  });
  const deleted = await store.deleteAutomation({
    automationSlug: "approvals-verify",
    environment: deployment.environment,
  });
  const kept = await audit.list({
    automation: "approvals-verify",
    environments: null,
    limit: 10,
    projectIds: [project.id],
  });
  assert.deepEqual(
    kept
      .filter((event) => event.change === null)
      .map((event) => [event.id, event.status, event.target.runId, event.details]),
    [[eventId, 200, runId, { reason: "verify" }]],
    "the event names the deleted automation's run",
  );
  assert.equal(deleted.kept.auditEvents, 2, "request and deployment history both survive");
  assert.deepEqual(
    kept.flatMap((event) =>
      event.change?.kind === "deployment" ? [[event.change.deploymentId, event.actor.kind]] : [],
    ),
    [[deployment.deploymentId, "system"]],
  );
  const inEnvironment = async (environment: string) =>
    (await audit.list({ environments: [environment], limit: 10, projectIds: [project.id] })).map(
      (event) => event.id,
    );
  assert.deepEqual(
    await inEnvironment(deployment.environment),
    kept.map((event) => event.id),
  );
  assert.deepEqual(await inEnvironment("elsewhere"), [], "a token's environments bound its view");

  const historyProject = await access.createProject({
    name: "Audit history",
    slug: "audit-history",
  });
  const moved = await commitDeploymentFixture(store, "audit-history-only", historyProject.id);
  await store.updateAutomationTriggerStatus({
    automationSlug: moved.automationSlug,
    environment: moved.environment,
    status: "paused",
    updatedAt: new Date().toISOString(),
  });
  await store.moveAutomation({ automationSlug: moved.automationSlug, projectId: project.id });
  const historyBefore = await audit.list({
    environments: null,
    limit: 10,
    projectIds: [historyProject.id],
  });
  assert.equal(
    (await store.deleteProject({ contents: null, projectId: historyProject.id })).contents,
    "empty",
    "audit events alone never keep a project",
  );
  assert.deepEqual(
    (await audit.list({ environments: null, limit: 10, projectIds: [historyProject.id] })).map(
      (event) => event.id,
    ),
    historyBefore.map((event) => event.id),
    "a deleted project's audit events stay readable",
  );
  assert.ok(historyBefore.length > 0);
  await auditScope.run(
    { eventId: null, actor: { kind: "system" }, requestId: "verify-audit-insert-retry" },
    async () => {
      const event = {
        action: "POST /retry",
        actor: { kind: "system" },
        details: null,
        params: {},
        privileged: false,
        requestId: "verify-audit-insert-retry",
        target: NO_AUDIT_TARGET,
      } as const;
      await assert.rejects(audit.begin({ ...event, action: "x".repeat(256) }));
      assert.equal(auditScope.getStore()?.eventId, null, "failed INSERT releases its reservation");
      const id = await audit.begin(event);
      await audit.finish(id, 503);
      const events = await audit.list({ environments: null, projectIds: null, limit: null });
      assert.deepEqual(
        events
          .filter((row) => row.requestId === event.requestId)
          .map((row) => ({
            action: row.action,
            status: row.status,
          })),
        [{ action: "POST /retry", status: 503 }],
      );
    },
  );
  await auditScope.run(
    { eventId: null, actor: { kind: "system" }, requestId: "verify-resource-insert-retry" },
    async () => {
      const input = {
        occurredAt: new Date().toISOString(),
        change: { kind: "worker", action: "enrolled", workerId: randomUUID(), issuedBy: null },
      } as const;
      await assert.rejects(
        audit.record({ ...input, change: { ...input.change, workerId: "invalid" } }),
      );
      assert.equal(
        auditScope.getStore()?.eventId,
        null,
        "failed resource INSERT releases its reservation",
      );
      await audit.record(input);
      const events = await audit.list({
        environments: null,
        projectIds: null,
        workerId: input.change.workerId,
        limit: null,
      });
      assert.deepEqual(
        events.map((row) => row.change),
        [input.change],
      );
    },
  );
  await auditScope.run(
    { eventId: null, actor: { kind: "system" }, requestId: "verify-audit-race" },
    async () => {
      const workerId = randomUUID();
      const id = await audit.begin({
        action: "POST /one-change",
        actor: { kind: "system" },
        details: null,
        params: {},
        privileged: false,
        requestId: "verify-audit-race",
        target: { ...NO_AUDIT_TARGET, projectId: project.id },
      });
      await audit.describe(id, {
        details: null,
        privileged: false,
        target: { ...NO_AUDIT_TARGET, projectId: historyProject.id, environment: "staging" },
      });
      await audit.describe(id, {
        details: null,
        privileged: false,
        target: { ...NO_AUDIT_TARGET, environment: "production", runId },
      });
      const input = {
        occurredAt: new Date().toISOString(),
        change: { kind: "worker", action: "created", workerId, issuedBy: null },
      } as const;
      const race = await Promise.allSettled([audit.record(input), audit.record(input)]);
      assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(race.filter((result) => result.status === "rejected").length, 1);
      await audit.finish(id, 200);
      const events = await audit.list({
        environments: null,
        projectIds: null,
        workerId,
        limit: null,
      });
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.change, input.change);
      assert.deepEqual(events[0]?.target, {
        ...NO_AUDIT_TARGET,
        projectId: project.id,
        environment: "staging",
        runId,
      });
      assert.equal(events[0]?.status, 200);
    },
  );
  await auditScope.run(
    { eventId: null, actor: { kind: "system" }, requestId: "verify-worker-audit-race" },
    async () => {
      const workerId = randomUUID();
      const input = {
        occurredAt: new Date().toISOString(),
        change: { kind: "worker", action: "enrolled", workerId, issuedBy: null },
      } as const;
      const race = await Promise.allSettled([audit.record(input), audit.record(input)]);
      assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
      const events = await audit.list({
        environments: null,
        projectIds: null,
        workerId,
        limit: null,
      });
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.change, input.change);
    },
  );
  process.stdout.write(
    "Postgres audit: failed request and resource inserts release reservations for retry; one envelope, first target facts retained, concurrent enrichment and standalone worker records admit one change per request.\n",
  );
}

/** A run waiting at the approval step `gate`, assigned to `assignee`. */
async function waitingApproval(
  store: ControlPlaneStore,
  deployment: Awaited<ReturnType<typeof commitDeploymentFixture>>,
  assignee: ApprovalAssignee,
): Promise<string> {
  const runId = randomUUID();
  await createQueuedRun(store, deployment, runId, `job-${runId}`, { case: "approvals" });
  await store.updateRunState({
    attemptsMade: 1,
    runId,
    status: "waiting",
    wait: {
      assignee,
      stepKey: "gate",
      reason: "approval",
      until: null,
      details: null,
      startedAt: new Date().toISOString(),
    },
  });
  return runId;
}

it("approvals and audit", { timeout: 60_000 }, async () => {
  const client = testDatabase();
  const store = testControlPlaneStore();
  await verifyApprovalsAndAudit(client, store);
});
