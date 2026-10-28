import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  commitDeploymentFixture,
  createQueuedRun,
} from "../../../scripts/verify-state-fixtures.js";
import { testControlPlaneStore } from "../../../test/stores.js";

import { NO_SIGNALS } from "./api-signals.js";
import { createOutputRedactor } from "./output-redaction.js";
import { applyRunEvents, finishRunExecution, type RunStepEvent } from "./run-lifecycle.js";

// Automations report step results as JSON lines on stderr; everything else on stderr is a log.
describe("structured stderr step events", () => {
  it("persists a valid step_result event", async () => {
    const run = await createRun();

    expect(await run.consume(stepLine("step-a", { ok: true }))).toBe("");

    expect(await run.steps()).toEqual([
      expect.objectContaining({ executionNumber: 1, stepKey: "step-a", value: { ok: true } }),
    ]);
  });

  it("keeps the first persisted result when a retry reports the same step again", async () => {
    const run = await createRun();

    run.consume(stepLine("step-a", "first"), { executionNumber: 1 });
    run.consume(stepLine("step-a", "second"), { executionNumber: 2 });

    expect(await run.steps()).toEqual([
      expect.objectContaining({ executionNumber: 1, stepKey: "step-a", value: "first" }),
    ]);
    expect(run.reported).toEqual([
      expect.objectContaining({ executionNumber: 1, key: "step-a", status: "done" }),
    ]);
  });

  it("records a started step, completes it with its result and reports both", async () => {
    const run = await createRun();

    run.consume(startLine("step-a"));
    await Promise.all(run.pending);
    expect(await run.steps()).toEqual([
      expect.objectContaining({ finishedAt: null, stepKey: "step-a", value: null }),
    ]);
    expect((await run.steps())[0]?.startedAt).not.toBeNull();

    run.consume(stepLine("step-a", { ok: true }));
    await Promise.all(run.pending);
    const [step] = await run.steps();
    expect(step).toMatchObject({ stepKey: "step-a", value: { ok: true } });
    expect(step?.finishedAt).not.toBeNull();
    expect(run.reported).toEqual([
      expect.objectContaining({ key: "step-a", status: "started" }),
      expect.objectContaining({ key: "step-a", status: "done" }),
    ]);
  });

  it("restarts a step whose attempt died inside it and leaves a finished step alone", async () => {
    const run = await createRun();

    run.consume(startLine("step-a"), { executionNumber: 1 });
    run.consume(startLine("step-a"), { executionNumber: 2 });
    run.consume(stepLine("step-a", "second"), { executionNumber: 2 });
    run.consume(startLine("step-a"), { executionNumber: 3 });
    await Promise.all(run.pending);

    expect(await run.steps()).toEqual([
      expect.objectContaining({ executionNumber: 2, stepKey: "step-a", value: "second" }),
    ]);
    expect(run.reported.map((event) => `${event.status}@${event.executionNumber}`)).toEqual([
      "started@1",
      "started@2",
      "done@2",
    ]);
  });

  it("lets a result bring the run's total exactly to the limit, also after its own start", async () => {
    const run = await createRun();
    // 80 results of 64 KiB each are exactly 5 MiB; the 80th follows its start, whose row is replaced.
    const value = "x".repeat(64 * 1024 - 2);
    for (let i = 1; i < 80; i += 1) run.consume(stepLine(`step-${i}`, value));
    run.consume(startLine("step-80"));
    run.consume(stepLine("step-80", value));
    await Promise.all(run.pending);
    expect(run.failure).toBeNull();
    expect((await run.steps()).filter((entry) => entry.finishedAt !== null)).toHaveLength(80);

    run.consume(stepLine("step-81", "y"));
    await Promise.allSettled(run.pending);
    expect(run.failure).toMatchObject({ code: "AUTOMATION_STEP_LIMIT_EXCEEDED" });
  });

  it("stops a stream of starts at the run's step count limit, but lets a known step restart", async () => {
    const run = await createRun();
    const lines = Array.from({ length: 2_000 }, (_, i) => startLine(`start-${i}`)).join("");
    run.consume(lines);
    await Promise.all(run.pending);
    expect(run.failure).toBeNull();

    run.consume(startLine("start-7"), { executionNumber: 2 });
    await Promise.all(run.pending);
    expect(run.failure).toBeNull();

    run.consume(startLine("start-2000"));
    await Promise.allSettled(run.pending);
    expect(run.failure).toMatchObject({ code: "AUTOMATION_STEP_LIMIT_EXCEEDED" });
  });

  it("fails the run with a terminal step limit error for an invalid step key", async () => {
    const run = await createRun();

    run.consume(stepLine("", true));
    await Promise.allSettled(run.pending);

    expect(run.failure).toMatchObject({ code: "AUTOMATION_STEP_LIMIT_EXCEEDED" });
  });

  it("ignores plain log lines and joins an event split across chunks", async () => {
    const run = await createRun();

    const rest = await run.consume('plain log line\n{"type":"step_result","key":"split');
    expect(await run.consume('-step","value":42}\n', { buffer: rest })).toBe("");

    expect(await run.steps()).toEqual([
      expect.objectContaining({ stepKey: "split-step", value: 42 }),
    ]);
  });
});

function stepLine(key: string, value: unknown): string {
  return `${JSON.stringify({ key, type: "step_result", value })}\n`;
}

function startLine(key: string): string {
  return `${JSON.stringify({ key, type: "step_start" })}\n`;
}

async function createRun() {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "step-events");
  const runId = randomUUID();
  await createQueuedRun(store, deployment, runId, "steps", {});

  async function currentRun(executionNumber: number) {
    let record = await store.getRun(runId);
    if (record === null) throw new Error("Expected a persisted run");
    if (!record.executions.some((entry) => entry.executionNumber === executionNumber)) {
      await store.createRunExecution({
        runId,
        executionNumber,
        attempt: executionNumber,
        workerName: "test-worker",
        queueJobId: runId,
        startedAt: new Date().toISOString(),
        status: "running",
      });
      record = await store.getRun(runId);
      if (record === null) throw new Error("Expected a persisted run");
    }
    return record;
  }

  const pending: Promise<unknown>[] = [];
  let last: Promise<unknown> = Promise.resolve();
  const run = {
    failure: null as unknown,
    pending,
    reported: [] as RunStepEvent[],
    /** Resolves to the unfinished line, which the next chunk passes back as `buffer`. */
    consume(chunk: string, options: { executionNumber?: number; buffer?: string } = {}) {
      const applied = last.then(async () => {
        const executionNumber = options.executionNumber ?? 1;
        const result = await applyRunEvents({
          chunk,
          lease: { executionNumber },
          line: options.buffer ?? "",
          onStep: (event) => {
            run.reported.push(event);
          },
          run: await currentRun(executionNumber),
          store,
        });
        run.failure ??= result.failed?.error ?? null;
        return result.line;
      });
      last = applied;
      pending.push(applied);
      return applied;
    },
    async steps() {
      await Promise.all(pending);
      return await store.listRunSteps({ runId });
    },
  };
  return run;
}

it("skips child creation when cancellation wins during the waiting transition", async () => {
  const store = testControlPlaneStore();
  const deployment = await commitDeploymentFixture(store, "suspend-parent");
  await commitDeploymentFixture(store, "suspend-child");
  const runId = randomUUID();
  await createQueuedRun(store, deployment, runId, runId, {});
  await store.createRunExecution({
    workerName: "test-worker",
    executionNumber: 1,
    attempt: 1,
    metadata: {},
    queueJobId: runId,
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
  });
  await store.updateRunState({ runId, status: "running", attemptsMade: 1 });
  const update = store.updateRunState.bind(store);
  const waiting = vi.spyOn(store, "updateRunState").mockImplementation(async (change) => {
    if (change.status === "waiting") {
      // The suspended execution already exists. A separate committed cancellation wins before
      // the waiting UPDATE, whose terminal guard must prevent child creation.
      expect((await store.getRun(runId))?.executions[0]?.status).toBe("suspended");
      await store.cancelRun({ runId, finishedAt: new Date().toISOString() });
    }
    await update(change);
  });
  const outcome = await finishRunExecution({
    execution: {
      durationMs: 1,
      exitCode: 0,
      payload: {},
      runId,
      stderr: "",
      stdout: "",
      success: true,
      result: {
        $swizzle: {
          suspend: {
            reason: "child",
            stepKey: "invoke",
            automation: "suspend-child",
            payload: {},
          },
        },
      },
    },
    lease: {
      runId,
      checkId: null,
      dueAt: null,
      taskId: runId,
      workerId: randomUUID(),
      generation: 1,
      executionNumber: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      remainingMs: 90_000,
    },
    line: "",
    signals: NO_SIGNALS,
    redactor: createOutputRedactor([]),
    store,
  });
  expect(waiting.mock.calls.some(([change]) => change.status === "waiting")).toBe(true);
  expect(outcome.run).toMatchObject({ status: "dead-lettered", errorCode: "RUN_CANCELLED" });
  expect(await store.listChildRuns({ parentRunId: runId })).toEqual([]);
});
