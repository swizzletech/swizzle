import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";

import { createWaitLinkToken } from "./wait-links.js";

// Durable waits: sleeps, events and approvals, their timeouts and resolution guards.

const ANNA = {
  kind: "user",
  label: "anna@example.com",
  userId: "9f7943c3-f124-5a15-97cb-4f5267ab36d4",
} as const;
const FINANCE = {
  kind: "team",
  label: "Finance",
  teamId: "19be60be-0d8f-51b9-8e30-81c26bc0b297",
} as const;
const BEN = {
  kind: "person",
  label: "ben@example.com",
  userId: "8f7176b8-8cf3-5b2c-aea0-8d999d55115c",
} as const;

beforeEach(async () => {
  await testDatabase().pool.query(
    "INSERT INTO auth_users (id, name, email, role) VALUES ($1, 'Anna', $2, 'member'), ($3, 'Ben', $4, 'member')",
    [ANNA.userId, ANNA.label, BEN.userId, BEN.label],
  );
  await testDatabase().pool.query(
    "INSERT INTO teams (id, name, normalized_name) VALUES ($1, 'Finance', 'finance')",
    [FINANCE.teamId],
  );
});

describe("platform waits and approvals", () => {
  it("resumes a sleeping run only after its waitUntil is due", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const waitUntil = "2030-01-01T00:00:00.000Z";
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "if (!Object.hasOwn(steps, 'sleep-step')) {",
        `  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'sleep', stepKey: 'sleep-step', until: '${waitUntil}' } } }) + '\\n');`,
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({",
        "  attempt: Number(process.env.SWIZZLE_ATTEMPT),",
        "  execution: Number(process.env.SWIZZLE_EXECUTION),",
        "  slept: steps['sleep-step'],",
        "}));",
        "",
      ].join("\n"),
      name: "sleeping-run",
      triggerLines: ["  type: webhook", "  path: /sleeping-run"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "e16045f6-08dc-5c8d-8c2c-3b4d43710199",
    });
    const queued = await platform.startManualRun({
      environment: "local",
      automationName: "sleeping-run",
      payload: {},
    });

    const suspended = await platform.processNextPlatformRun();
    expect(suspended).toMatchObject({
      runId: queued.runId,
      status: "waiting",
      wait: { reason: "sleep", stepKey: "sleep-step", until: waitUntil },
    });

    const early = await platform.resumeDueWaitingRuns({
      environment: "local",
      now: new Date("2029-12-31T23:59:59.999Z"),
    });
    expect(early).toEqual({
      resumedCount: 0,
      resumedRunIds: [],
      skippedRunIds: [],
    });
    expect((await platform.getPlatformRun(queued.runId)).status).toBe("waiting");

    const due = await platform.resumeDueWaitingRuns({
      environment: "local",
      now: new Date(waitUntil),
    });
    expect(due).toEqual({
      resumedCount: 1,
      resumedRunIds: [queued.runId],
      skippedRunIds: [],
    });

    const resumed = await platform.processNextPlatformRun();
    expect(resumed).toMatchObject({
      runId: queued.runId,
      status: "succeeded",
    });
    // The second execution resumes the run and spends no retry: it is still attempt 1.
    expect(resumed?.result).toEqual({
      attempt: 1,
      execution: 2,
      slept: { sleptUntil: waitUntil },
    });

    const persisted = await platform.getPlatformRun(queued.runId);
    expect(persisted.wait).toBeNull();
    expect(persisted.executions).toMatchObject([
      { executionNumber: 1, status: "suspended" },
      { executionNumber: 2, status: "succeeded" },
    ]);
  });

  it.each([
    { maxAttempts: 1, waits: 2, failsOnceAfterWaits: false, attempts: [1, 1, 1] },
    { maxAttempts: 2, waits: 3, failsOnceAfterWaits: true, attempts: [1, 1, 1, 1, 2] },
  ])(
    "counts a resume as no retry ($waits waits, max_attempts $maxAttempts)",
    async ({ maxAttempts, waits, failsOnceAfterWaits, attempts }) => {
      const stateDirectory = await temporaryDirectory("swizzle-platform-");
      const platform = await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      });
      const until = "2000-01-01T00:00:00.000Z";
      const automationDirectory = await createAutomationFixture({
        configLines: ["runtime:", "  retry:", `    max_attempts: ${maxAttempts}`],
        mainJs: [
          "const fs = require('node:fs');",
          "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
          `for (let wait = 1; wait <= ${waits}; wait++) {`,
          "  const stepKey = 'nap-' + wait;",
          "  if (Object.hasOwn(steps, stepKey)) continue;",
          `  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'sleep', stepKey, until: '${until}' } } }) + '\\n');`,
          "  process.exit(0);",
          "}",
          `if (${failsOnceAfterWaits} && process.env.SWIZZLE_EXECUTION === '${waits + 1}') process.exit(1);`,
          "console.log(JSON.stringify({ ok: true }));",
          "",
        ].join("\n"),
        name: "napping-run",
        triggerLines: ["  type: webhook", "  path: /napping-run"],
      });
      await platform.deployAutomationToPlatform({ environment: "local", automationDirectory });
      const queued = await platform.startManualRun({
        environment: "local",
        automationName: "napping-run",
        payload: {},
      });

      const seen: number[] = [];
      for (let run = await platform.processNextPlatformRun(); run !== null; ) {
        seen.push(run.attemptsMade);
        if (run.status === "waiting") {
          await platform.resumeDueWaitingRuns({ environment: "local", now: new Date(until) });
        }
        run = await platform.processNextPlatformRun();
      }

      const finished = await platform.getPlatformRun(queued.runId);
      expect(seen).toEqual(attempts);
      expect(finished).toMatchObject({
        attemptsMade: attempts.at(-1),
        attemptsMax: maxAttempts,
        status: "succeeded",
      });
    },
  );

  it("counts a cancelled resumed attempt within its segment", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const until = "2000-01-01T00:00:00.000Z";
    const automationDirectory = await createAutomationFixture({
      configLines: ["runtime:", "  retry:", "    max_attempts: 1"],
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "for (const stepKey of ['nap-1', 'nap-2']) {",
        "  if (Object.hasOwn(steps, stepKey)) continue;",
        `  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'sleep', stepKey, until: '${until}' } } }) + '\\n');`,
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ ok: true }));",
        "",
      ].join("\n"),
      name: "cancelled-napper",
      triggerLines: ["  type: webhook", "  path: /cancelled-napper"],
    });
    await platform.deployAutomationToPlatform({ environment: "local", automationDirectory });
    const queued = await platform.startManualRun({
      environment: "local",
      automationName: "cancelled-napper",
      payload: {},
    });
    for (let wait = 1; wait <= 2; wait++) {
      expect((await platform.processNextPlatformRun())?.status).toBe("waiting");
      await platform.resumeDueWaitingRuns({ environment: "local", now: new Date(until) });
    }
    // The worker's start of the third execution, which the user cancels while it runs.
    const startedAt = new Date().toISOString();
    await platform.store.updateRunState({
      attemptsMade: 1,
      runId: queued.runId,
      status: "running",
    });
    await platform.store.createRunExecution({
      workerName: "test-worker",
      executionNumber: 3,
      attempt: 1,
      metadata: {},
      queueJobId: queued.runId,
      runId: queued.runId,
      startedAt,
      status: "running",
    });

    const cancelled = await platform.cancelPlatformRun(queued.runId);

    expect(cancelled.run).toMatchObject({
      attemptsMade: 1,
      attemptsMax: 1,
      deadLetterReason: "user-cancelled",
    });
  });

  it("suspends for waitForEvent, resolves through the facade, and resumes with the envelope", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "if (!Object.hasOwn(steps, 'external-event')) {",
        "  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'event', stepKey: 'external-event', approval: false } } }) + '\\n');",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ event: steps['external-event'] }));",
        "",
      ].join("\n"),
      name: "wait-for-event-run",
      triggerLines: ["  type: webhook", "  path: /wait-for-event-run"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "c999d3d0-115e-5def-9207-30191af55ac8",
    });
    const queued = await platform.startManualRun({
      environment: "local",
      automationName: "wait-for-event-run",
      payload: {},
    });

    const suspended = await platform.processNextPlatformRun();
    expect(suspended).toMatchObject({
      runId: queued.runId,
      status: "waiting",
      wait: { stepKey: "external-event", reason: "event" },
    });

    const resolved = await platform.resolveRunEvent({
      runId: queued.runId,
      stepKey: "external-event",
      value: { answer: 42 },
    });
    expect(resolved).toMatchObject({ status: "resolved" });

    const resumed = await platform.processNextPlatformRun();
    expect(resumed).toMatchObject({
      status: "succeeded",
      result: {
        event: { timedOut: false, value: { answer: 42 } },
      },
      wait: null,
    });
  });

  it("records who decided an assigned approval, and the approval link only an unassigned one", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "if (!Object.hasOwn(steps, 'manager-approval')) {",
        "  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'event', stepKey: 'manager-approval', approval: true, assignee: { user: 'anna@example.com' }, details: { invoice: 'A-1' } } } }) + '\\n');",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ approval: steps['manager-approval'] }));",
        "",
      ].join("\n"),
      name: "approval-run",
      triggerLines: ["  type: webhook", "  path: /approval-run"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "8088f6de-0c56-5f6a-b6d6-2b70f7170b29",
    });

    const approveRun = await platform.startManualRun({
      environment: "local",
      automationName: "approval-run",
      payload: {},
    });
    expect(await platform.processNextPlatformRun()).toMatchObject({
      status: "waiting",
      wait: {
        reason: "approval",
        stepKey: "manager-approval",
        assignee: ANNA,
        details: { invoice: "A-1" },
      },
    });
    const decision = {
      approved: true,
      comment: "ship it",
      runId: approveRun.runId,
      stepKey: "manager-approval",
    };
    // The link checks the wait is unassigned; Anna's decision checks it is still hers.
    expect(
      await platform.decideApproval({ ...decision, assignee: null, decidedBy: { kind: "link" } }),
    ).toMatchObject({ status: "not-waiting" });
    expect(
      await platform.decideApproval({
        ...decision,
        assignee: ANNA,
        decidedBy: { kind: "person", label: ANNA.label, userId: ANNA.userId },
      }),
    ).toMatchObject({ status: "resolved" });
    expect((await platform.processNextPlatformRun())?.result).toEqual({
      approval: {
        approved: true,
        assignee: ANNA,
        comment: "ship it",
        decidedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        decidedBy: { kind: "person", label: ANNA.label, userId: ANNA.userId },
        timedOut: false,
      },
    });

    const rejectRun = await platform.startManualRun({
      environment: "local",
      automationName: "approval-run",
      payload: {},
    });
    expect((await platform.processNextPlatformRun())?.status).toBe("waiting");
    // Reassigned to Finance, Anna's decision no longer lands; a member of Finance decides.
    expect(
      await platform.reassignApproval({
        from: ANNA,
        runId: rejectRun.runId,
        stepKey: "manager-approval",
        to: FINANCE,
      }),
    ).toBe(true);
    const rejection = {
      approved: false,
      comment: "needs review",
      runId: rejectRun.runId,
      stepKey: "manager-approval",
    };
    expect(
      await platform.decideApproval({
        ...rejection,
        assignee: ANNA,
        decidedBy: { kind: "person", label: ANNA.label, userId: ANNA.userId },
      }),
    ).toMatchObject({ status: "not-waiting" });
    await platform.decideApproval({ ...rejection, assignee: FINANCE, decidedBy: BEN });
    expect((await platform.processNextPlatformRun())?.result).toMatchObject({
      approval: {
        approved: false,
        assignee: FINANCE,
        comment: "needs review",
        decidedBy: BEN,
        timedOut: false,
      },
    });
  });

  it("lands exactly one of two concurrent decisions, and records that one", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const runId = await waitingForFinance(platform);

    const deciders = [
      BEN,
      {
        kind: "person",
        label: "cleo@example.com",
        userId: "d513823d-050d-5823-a93e-66beddb34772",
      } as const,
    ];
    const outcomes = await Promise.all(
      deciders.map((decidedBy, index) =>
        platform.decideApproval({
          approved: index === 0,
          assignee: FINANCE,
          comment: null,
          decidedBy,
          runId,
          stepKey: "gate",
        }),
      ),
    );

    const winner = outcomes.findIndex((outcome) => outcome.status === "resolved");
    expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual([
      "not-waiting",
      "resolved",
    ]);
    expect((await platform.processNextPlatformRun())?.result).toMatchObject({
      approved: winner === 0,
      decidedBy: deciders[winner],
    });
  });

  it("matches the assignee by identity, and leaves a run waiting whose step already finished", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const runId = await waitingForFinance(platform);
    // The step already holds a result, as after a decision that landed on another path.
    await platform.store.setRunStepResult({ executionNumber: 1, runId, stepKey: "gate", value: 1 });
    const decide = (assignee: typeof FINANCE) =>
      platform.decideApproval({
        approved: true,
        assignee,
        comment: null,
        decidedBy: BEN,
        runId,
        stepKey: "gate",
      });
    expect((await decide(FINANCE)).status).toBe("not-waiting");
    expect((await platform.getPlatformRun(runId)).status).toBe("waiting");

    const second = await waitingForFinance(platform);
    const reordered = { teamId: FINANCE.teamId, label: FINANCE.label, kind: "team" } as const;
    expect(
      (
        await platform.decideApproval({
          approved: true,
          assignee: reordered,
          comment: null,
          decidedBy: BEN,
          runId: second,
          stepKey: "gate",
        })
      ).status,
    ).toBe("resolved");
  });

  it("fails a run whose approval names nobody with an account", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs:
        "process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'event', stepKey: 'gate', approval: true, assignee: { user: 'nobody@example.com' } } } }) + '\\n');\n",
      name: "unknown-assignee",
      triggerLines: ["  type: webhook", "  path: /unknown-assignee"],
    });
    await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });
    await platform.startManualRun({
      automationName: "unknown-assignee",
      environment: "local",
      payload: {},
    });

    expect(await platform.processNextPlatformRun()).toMatchObject({
      errorCode: "APPROVAL_ASSIGNEE_NOT_FOUND",
      wait: null,
    });
  });

  it("times out event and approval waits through the due waiting sweep", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const waitUntil = "2026-07-09T00:00:00.000Z";
    const eventDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "if (!Object.hasOwn(steps, 'event-timeout')) {",
        `  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'event', stepKey: 'event-timeout', until: '${waitUntil}' } } }) + '\\n');`,
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ event: steps['event-timeout'] }));",
        "",
      ].join("\n"),
      name: "event-timeout-run",
      triggerLines: ["  type: webhook", "  path: /event-timeout-run"],
    });
    const approvalDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "if (!Object.hasOwn(steps, 'approval-timeout')) {",
        `  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'event', stepKey: 'approval-timeout', approval: true, assignee: { user: 'anna@example.com' }, until: '${waitUntil}' } } }) + '\\n');`,
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ approval: steps['approval-timeout'] }));",
        "",
      ].join("\n"),
      name: "approval-timeout-run",
      triggerLines: ["  type: webhook", "  path: /approval-timeout-run"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: eventDirectory,
      deploymentId: "f30c793d-8d3f-54cd-a3ee-22e5ccd836b2",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: approvalDirectory,
      deploymentId: "e48346a4-5683-5613-b8e5-063037cf3a3e",
    });

    const eventRun = await platform.startManualRun({
      environment: "local",
      automationName: "event-timeout-run",
      payload: {},
    });
    expect((await platform.processNextPlatformRun())?.status).toBe("waiting");
    const approvalRun = await platform.startManualRun({
      environment: "local",
      automationName: "approval-timeout-run",
      payload: {},
    });
    expect((await platform.processNextPlatformRun())?.status).toBe("waiting");

    const swept = await platform.resumeDueWaitingRuns({
      environment: "local",
      now: new Date(waitUntil),
    });
    expect(swept).toMatchObject({
      resumedCount: 2,
      skippedRunIds: [],
    });

    const resumedResults = [
      await platform.processNextPlatformRun(),
      await platform.processNextPlatformRun(),
    ];
    const eventResult = resumedResults.find((run) => run?.runId === eventRun.runId);
    const approvalResult = resumedResults.find((run) => run?.runId === approvalRun.runId);
    expect(eventResult?.result).toEqual({ event: { timedOut: true, value: null } });
    expect(approvalResult?.result).toEqual({
      approval: {
        approved: false,
        assignee: ANNA,
        comment: null,
        decidedAt: waitUntil,
        decidedBy: null,
        timedOut: true,
      },
    });
  });

  it("guards event resolution for cancelled, mismatched, and double-resolved waits", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'event', stepKey: 'guarded-event' } } }) + '\\n');",
        "",
      ].join("\n"),
      name: "guarded-event-run",
      triggerLines: ["  type: webhook", "  path: /guarded-event-run"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory,
      deploymentId: "2c40fe35-e0c7-5521-bc22-115f920faa4b",
    });

    const cancelled = await platform.startManualRun({
      environment: "local",
      automationName: "guarded-event-run",
      payload: {},
    });
    expect((await platform.processNextPlatformRun())?.status).toBe("waiting");
    await platform.cancelPlatformRun(cancelled.runId);
    const cancelledResolve = await platform.resolveRunEvent({
      runId: cancelled.runId,
      stepKey: "guarded-event",
      value: "late",
    });
    expect(cancelledResolve.status).toBe("not-waiting");

    const mismatched = await platform.startManualRun({
      environment: "local",
      automationName: "guarded-event-run",
      payload: {},
    });
    expect((await platform.processNextPlatformRun())?.status).toBe("waiting");
    const mismatch = await platform.resolveRunEvent({
      runId: mismatched.runId,
      stepKey: "other-event",
      value: "wrong",
    });
    expect(mismatch.status).toBe("key-mismatch");

    const resolved = await platform.resolveRunEvent({
      runId: mismatched.runId,
      stepKey: "guarded-event",
      value: "first",
    });
    expect(resolved.status).toBe("resolved");
    const second = await platform.resolveRunEvent({
      runId: mismatched.runId,
      stepKey: "guarded-event",
      value: "second",
    });
    expect(second.status).toBe("not-waiting");
    const persisted = await platform.getPlatformRun(mismatched.runId);
    expect(persisted).toMatchObject({ status: "queued", wait: null });
  });

  describe("wait links", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // Two approval steps in a row, then an event wait with a one-hour timeout.
    async function startLinkedRun() {
      vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
      const stateDirectory = await temporaryDirectory("swizzle-platform-");
      const platform = await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      });
      const automationDirectory = await createAutomationFixture({
        mainJs: [
          "const fs = require('node:fs');",
          "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
          "const suspend = (s) => { process.stdout.write(JSON.stringify({ $swizzle: { suspend: s } }) + '\\n'); process.exit(0); };",
          "if (!Object.hasOwn(steps, 'first')) suspend({ reason: 'event', stepKey: 'first', approval: true });",
          "if (!Object.hasOwn(steps, 'second')) suspend({ reason: 'event', stepKey: 'second', approval: true });",
          "if (!Object.hasOwn(steps, 'paid')) suspend({ reason: 'event', stepKey: 'paid', until: new Date(Date.now() + 3600000).toISOString() });",
          "console.log(JSON.stringify(steps));",
          "",
        ].join("\n"),
        name: "linked-run",
        triggerLines: ["  type: webhook", "  path: /linked-run"],
      });
      await platform.deployAutomationToPlatform({
        automationDirectory,
        deploymentId: "8e9af014-29b9-5560-acae-30cc7ac7035c",
        environment: "local",
      });
      const { runId } = await platform.startManualRun({
        automationName: "linked-run",
        environment: "local",
        payload: {},
      });
      expect((await platform.processNextPlatformRun())?.wait?.stepKey).toBe("first");
      const token = (kind: "approval" | "event", stepKey: string) =>
        createWaitLinkToken({ kind, runId, stepKey });
      const decide = async (stepKey: string) => {
        await platform.decideApproval({
          approved: true,
          assignee: null,
          comment: null,
          decidedBy: { kind: "link" },
          runId,
          stepKey,
        });
        await platform.processNextPlatformRun();
      };
      return { decide, platform, runId, token };
    }

    it("opens only the step it names, and closes once that step is decided", async () => {
      const { decide, platform, runId, token } = await startLinkedRun();
      const find = (kind: "approval" | "event", value: string) =>
        platform.findWaitByLink({ kind, token: value });

      expect(await find("approval", token("approval", "first"))).toMatchObject({
        status: "open",
        wait: { runId, stepKey: "first" },
      });
      // A link for a later step of the same run does not open the current one.
      expect(await find("approval", token("approval", "second"))).toMatchObject({
        status: "closed",
      });
      // An event link is no approval link, and a changed signature is no link at all.
      expect(await find("event", token("event", "first"))).toMatchObject({ status: "closed" });
      expect(await find("approval", `${token("approval", "first").slice(0, -2)}xx`)).toEqual({
        status: "not-found",
      });

      await decide("first");
      expect(await find("approval", token("approval", "first"))).toMatchObject({
        status: "closed",
      });
      expect(await find("approval", token("approval", "second"))).toMatchObject({
        status: "open",
      });
    });

    it("closes when the wait's timeout passes, or a week after a wait without one began", async () => {
      const { decide, platform, token } = await startLinkedRun();
      const first = token("approval", "first");
      const open = await platform.findWaitByLink({ kind: "approval", token: first });
      expect(open.status).toBe("open");
      const expiresAt = open.status === "open" ? Date.parse(open.wait.expiresAt) : 0;
      expect(expiresAt - Date.now()).toBeGreaterThan(7 * 24 * 3_600_000 - 60_000);

      vi.useFakeTimers({ now: expiresAt, toFake: ["Date"] });
      expect(await platform.findWaitByLink({ kind: "approval", token: first })).toMatchObject({
        status: "closed",
      });
      vi.useRealTimers();

      await decide("first");
      await decide("second");
      const paid = token("event", "paid");
      expect(await platform.findWaitByLink({ kind: "event", token: paid })).toMatchObject({
        status: "open",
      });
      vi.useFakeTimers({ now: Date.now() + 3_600_000, toFake: ["Date"] });
      expect(await platform.findWaitByLink({ kind: "event", token: paid })).toMatchObject({
        status: "closed",
      });
    });
  });
});

/** A run of `raced-approval`, deployed on first use, waiting at the approval `gate` for Finance. */
async function waitingForFinance(
  platform: Awaited<ReturnType<typeof testPlatform>>,
): Promise<string> {
  if ((await platform.findAutomation("raced-approval")) === null) {
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "if (!Object.hasOwn(steps, 'gate')) {",
        "  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'event', stepKey: 'gate', approval: true, assignee: { team: 'Finance' } } } }) + '\\n');",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify(steps.gate));",
        "",
      ].join("\n"),
      name: "raced-approval",
      triggerLines: ["  type: webhook", "  path: /raced-approval"],
    });
    await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });
  }
  const { runId } = await platform.startManualRun({
    automationName: "raced-approval",
    environment: "local",
    payload: {},
  });
  expect((await platform.processNextPlatformRun())?.status).toBe("waiting");
  return runId;
}
