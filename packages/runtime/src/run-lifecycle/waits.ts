import type {
  ApprovalAssignee,
  ApprovalDecider,
  ApprovalDecision,
  ControlPlaneStore,
  PlatformRunWaitReason,
  StepResultInput,
} from "@swizzle/db";
import { isFinishedRun } from "@swizzle/db";
import type {
  PlatformRunRecord,
  ResolveWaitingEventRunResult,
  WaitLinkLookupResult,
} from "../platform-types.js";
import type { RunQueueProducer } from "../run-queue.js";
import { verifyWaitLinkToken, type WaitLinkKind } from "../wait-links.js";
import { assertStepWriteWithinLimits } from "./events.js";

const WAIT_LINK_DEFAULT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

import { enqueuePersistedRun } from "./enqueue.js";
import { getRunOrThrow } from "./records.js";

export async function resumeDueWaitingRunsWithStore(input: {
  readonly environment?: string;
  readonly limit?: number;
  readonly now?: Date;
  readonly queue: RunQueueProducer;
  readonly store: ControlPlaneStore;
}): Promise<{
  readonly resumedCount: number;
  readonly resumedRunIds: readonly string[];
  readonly skippedRunIds: readonly string[];
}> {
  const now = input.now ?? new Date();
  const dueRuns = await input.store.listDueWaitingRuns({
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    now: now.toISOString(),
  });

  const resumedRunIds: string[] = [];
  const skippedRunIds: string[] = [];

  for (const run of dueRuns) {
    if (run.wait?.reason === "sleep") {
      const resumed = await resumeWaitingRunAndEnqueue({
        expectedWaitReason: "sleep",
        queue: input.queue,
        result: { value: { sleptUntil: run.wait.until } },
        runId: run.runId,
        stepKey: run.wait.stepKey,
        store: input.store,
      });
      if (resumed === null) {
        skippedRunIds.push(run.runId);
        continue;
      }
      resumedRunIds.push(resumed.runId);
      continue;
    }

    if (run.wait?.reason !== "event" && run.wait?.reason !== "approval") {
      skippedRunIds.push(run.runId);
      continue;
    }

    const resumed = await resumeWaitingRunAndEnqueue({
      ...(run.wait?.reason === "approval" ? { expectedAssignee: run.wait.assignee } : {}),
      expectedWaitReason: run.wait?.reason,
      queue: input.queue,
      result:
        run.wait?.reason === "approval"
          ? {
              approval: {
                approved: false,
                assignee: run.wait.assignee,
                comment: null,
                decidedAt: now.toISOString(),
                decidedBy: null,
                timedOut: true,
              },
            }
          : { value: { timedOut: true, value: null } },
      runId: run.runId,
      stepKey: run.wait.stepKey,
      store: input.store,
    });
    if (resumed === null) {
      skippedRunIds.push(run.runId);
      continue;
    }
    resumedRunIds.push(resumed.runId);
  }

  return {
    resumedCount: resumedRunIds.length,
    resumedRunIds,
    skippedRunIds,
  };
}

export async function resolveWaitingEventRun(input: {
  readonly queue: RunQueueProducer;
  readonly run: PlatformRunRecord;
  readonly stepKey: string;
  readonly store: ControlPlaneStore;
  readonly value: unknown;
}): Promise<ResolveWaitingEventRunResult> {
  if (input.run.status !== "waiting" || input.run.wait?.reason !== "event") {
    return { run: input.run, status: "not-waiting" };
  }
  if (input.run.wait.stepKey !== input.stepKey) {
    return { run: input.run, status: "key-mismatch" };
  }
  const value = { timedOut: false, value: input.value ?? null };
  assertStepWriteWithinLimits({
    result: { value },
    stepKey: input.stepKey,
    totals: await input.store.getRunStepTotals({
      runId: input.run.runId,
      stepKey: input.stepKey,
    }),
  });
  return await resumeResolvedWait({
    expectedWaitReason: "event",
    queue: input.queue,
    result: { value },
    run: input.run,
    stepKey: input.stepKey,
    store: input.store,
  });
}

export async function decideWaitingApproval(input: {
  readonly approved: boolean;
  readonly assignee: ApprovalAssignee | null;
  readonly comment: string | null;
  readonly decidedBy: ApprovalDecider;
  readonly queue: RunQueueProducer;
  readonly run: PlatformRunRecord;
  readonly stepKey: string;
  readonly store: ControlPlaneStore;
}): Promise<ResolveWaitingEventRunResult> {
  if (input.run.status !== "waiting" || input.run.wait?.reason !== "approval") {
    return { run: input.run, status: "not-waiting" };
  }
  if (input.run.wait.stepKey !== input.stepKey) {
    return { run: input.run, status: "key-mismatch" };
  }
  const comment = input.comment?.trim() ?? "";
  const approval: ApprovalDecision = {
    approved: input.approved,
    assignee: input.assignee,
    comment: comment === "" ? null : comment,
    decidedAt: new Date().toISOString(),
    decidedBy: input.decidedBy,
    timedOut: false,
  };
  assertStepWriteWithinLimits({
    result: { approval },
    stepKey: input.stepKey,
    totals: await input.store.getRunStepTotals({
      runId: input.run.runId,
      stepKey: input.stepKey,
    }),
  });
  return await resumeResolvedWait({
    expectedAssignee: input.assignee,
    expectedWaitReason: "approval",
    queue: input.queue,
    result: { approval },
    run: input.run,
    stepKey: input.stepKey,
    store: input.store,
  });
}

async function resumeResolvedWait(input: {
  readonly expectedAssignee?: ApprovalAssignee | null;
  readonly expectedWaitReason: "approval" | "event";
  readonly queue: RunQueueProducer;
  readonly result: StepResultInput;
  readonly run: PlatformRunRecord;
  readonly stepKey: string;
  readonly store: ControlPlaneStore;
}): Promise<ResolveWaitingEventRunResult> {
  const resumed = await resumeWaitingRunAndEnqueue({
    ...(input.expectedAssignee === undefined ? {} : { expectedAssignee: input.expectedAssignee }),
    expectedWaitReason: input.expectedWaitReason,
    queue: input.queue,
    result: input.result,
    runId: input.run.runId,
    stepKey: input.stepKey,
    store: input.store,
  });
  if (resumed === null) {
    return {
      run: (await input.store.getRun(input.run.runId)) ?? input.run,
      status: "not-waiting",
    };
  }
  return { run: resumed, status: "resolved" };
}

export async function findWaitByLink(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly kind: WaitLinkKind;
  readonly now?: Date;
  readonly store: ControlPlaneStore;
  readonly token: string;
}): Promise<WaitLinkLookupResult> {
  const target = verifyWaitLinkToken({
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    kind: input.kind,
    token: input.token,
  });
  if (target === null) return { status: "not-found" };
  const run = await input.store.getRun(target.runId);
  if (run === null) return { status: "not-found" };
  const audit = {
    automationId: run.automationId,
    automationSlug: run.automationSlug,
    environment: run.environment,
    projectId: run.projectId,
    runId: run.runId,
  };

  if (
    run.status !== "waiting" ||
    (run.wait?.reason !== "event" && run.wait?.reason !== "approval") ||
    run.wait.reason !== input.kind ||
    run.wait.stepKey !== target.stepKey
  ) {
    return { status: "closed", target: audit };
  }
  if (run.wait.reason === "approval" && run.wait.assignee !== null) {
    return { assignee: run.wait.assignee, status: "assigned", target: audit };
  }

  const expiresAt =
    run.wait.until ??
    new Date(Date.parse(run.wait.startedAt) + WAIT_LINK_DEFAULT_LIFETIME_MS).toISOString();
  if ((input.now ?? new Date()).getTime() >= Date.parse(expiresAt)) {
    return { status: "closed", target: audit };
  }
  return {
    status: "open",
    target: audit,
    wait: {
      automationName: run.automationName,
      details: run.wait.details,
      expiresAt,
      runId: run.runId,
      stepKey: target.stepKey,
    },
  };
}

export async function resumeParentAfterChildTerminal(input: {
  readonly retryFailures?: boolean;
  readonly childRun: PlatformRunRecord;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  if (
    input.childRun.parentRunId === null ||
    input.childRun.parentStepKey === null ||
    !isFinishedRun(input.childRun.status)
  ) {
    return;
  }

  try {
    const parent = await input.store.getRun(input.childRun.parentRunId);
    if (
      parent === null ||
      parent.status !== "waiting" ||
      parent.wait?.reason !== "child" ||
      parent.executions.length === 0
    ) {
      return;
    }

    if (parent.wait.stepKey !== input.childRun.parentStepKey) {
      return;
    }

    await input.store.resumeWaitingRun({
      expectedWaitReason: "child",
      result: {
        value: {
          automation: input.childRun.automationName,
          errorCode: input.childRun.errorCode ?? null,
          result: input.childRun.result ?? null,
          runId: input.childRun.runId,
          status: input.childRun.status,
        },
      },
      runId: parent.runId,
      stepKey: input.childRun.parentStepKey,
    });
  } catch (error) {
    if (input.retryFailures) throw error;
  }
}

async function resumeWaitingRunAndEnqueue(input: {
  readonly expectedAssignee?: ApprovalAssignee | null;
  readonly expectedWaitReason: PlatformRunWaitReason;
  readonly queue: RunQueueProducer;
  readonly result: StepResultInput;
  readonly runId: string;
  readonly stepKey: string;
  readonly store: ControlPlaneStore;
}): Promise<PlatformRunRecord | null> {
  const resumed = await input.store.resumeWaitingRun({
    ...(input.expectedAssignee === undefined ? {} : { expectedAssignee: input.expectedAssignee }),
    expectedWaitReason: input.expectedWaitReason,
    result: input.result,
    runId: input.runId,
    stepKey: input.stepKey,
  });
  if (resumed === null) {
    return null;
  }

  await enqueuePersistedRun({
    queue: input.queue,
    run: resumed,
    store: input.store,
  });

  return await getRunOrThrow(input.store, resumed.runId);
}
