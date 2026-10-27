import { createDisplayName } from "@swizzle/core";
import type { AssigneeRequest, ControlPlaneStore, RunWait } from "@swizzle/db";
import { CodedError, isFinishedRun } from "@swizzle/db";
import {
  AutomationRuntimeError,
  type AutomationRuntimeErrorCode,
  getErrorMessage,
} from "../errors.js";
import type { PlatformRunRecord } from "../platform-types.js";
import type { AutomationRunFailure, AutomationRunSuccess } from "../run-result.js";
import { persistRunFromDeployment } from "./enqueue.js";
import { isRecord } from "./events.js";
import { handleFailedRunExecution } from "./failure.js";
import { getRunOrThrow, type ProcessRunOutcome, serializeErrorCause } from "./records.js";
import { resumeParentAfterChildTerminal } from "./waits.js";

const MAX_SUSPEND_DETAILS_BYTES = 8 * 1024;

// An email address (auth_users.email) or a team name (teams.name) at most.
const MAX_ASSIGNEE_LENGTH = 320;

const MAX_INVOKE_DEPTH = 8;

type SuspendPayload =
  | {
      readonly reason: "sleep";
      readonly stepKey: string;
      readonly until: string;
    }
  | {
      readonly automation: string;
      readonly payload: unknown;
      readonly reason: "child";
      readonly stepKey: string;
    }
  | {
      readonly reason: "claim";
      readonly stepKey: string;
    }
  | {
      readonly details: unknown | null;
      readonly reason: "event";
      readonly stepKey: string;
      readonly until: string | null;
    }
  | {
      readonly reason: "approval";
      readonly assignee: AssigneeRequest | null;
      readonly details: unknown;
      readonly stepKey: string;
      readonly until: string | null;
    };

export function parseSuspendPayload(
  result: unknown,
):
  | { readonly invalid: false; readonly payload: SuspendPayload | null }
  | { readonly invalid: true; readonly message: string } {
  if (!isRecord(result)) {
    return { invalid: false, payload: null };
  }
  const swizzle = result.$swizzle;
  if (!isRecord(swizzle) || !Object.hasOwn(swizzle, "suspend")) {
    return { invalid: false, payload: null };
  }

  const suspend = swizzle.suspend;
  if (!isRecord(suspend)) {
    return { invalid: true, message: "Suspend payload must be an object." };
  }

  const stepKey = parseSuspendStepKey(suspend.stepKey);
  if (stepKey === null) {
    return {
      invalid: true,
      message: "Suspend payload stepKey must be a non-empty string up to 255 characters.",
    };
  }

  if (suspend.reason === "sleep") {
    if (typeof suspend.until !== "string" || Number.isNaN(Date.parse(suspend.until))) {
      return { invalid: true, message: "Sleep suspend payload requires a valid ISO until value." };
    }
    return {
      invalid: false,
      payload: {
        reason: "sleep",
        stepKey,
        until: new Date(suspend.until).toISOString(),
      },
    };
  }

  if (suspend.reason === "child") {
    if (typeof suspend.automation !== "string" || suspend.automation.length === 0) {
      return {
        invalid: true,
        message: "Child suspend payload requires a non-empty automation string.",
      };
    }
    return {
      invalid: false,
      payload: {
        automation: suspend.automation,
        payload: suspend.payload,
        reason: "child",
        stepKey,
      },
    };
  }

  if (suspend.reason === "claim") {
    return { invalid: false, payload: { reason: "claim", stepKey } };
  }

  if (suspend.reason === "event") {
    let until: string | null = null;
    if (suspend.until !== undefined && suspend.until !== null) {
      if (typeof suspend.until !== "string" || Number.isNaN(Date.parse(suspend.until))) {
        return {
          invalid: true,
          message: "Event suspend payload until must be a valid ISO timestamp when provided.",
        };
      }
      until = new Date(suspend.until).toISOString();
    }

    let details: unknown | null = null;
    if (Object.hasOwn(suspend, "details") && suspend.details !== undefined) {
      const serialized = JSON.stringify(suspend.details);
      if (serialized === undefined) {
        return { invalid: true, message: "Event suspend details must be JSON-serializable." };
      }
      if (Buffer.byteLength(serialized, "utf8") > MAX_SUSPEND_DETAILS_BYTES) {
        return {
          invalid: true,
          message: `Event suspend details exceed ${MAX_SUSPEND_DETAILS_BYTES} bytes.`,
        };
      }
      details = suspend.details;
    }

    let assignee: AssigneeRequest | null = null;
    if (suspend.approval === true && suspend.assignee !== undefined && suspend.assignee !== null) {
      assignee = parseAssigneeRequest(suspend.assignee);
      if (assignee === null) {
        return {
          invalid: true,
          message: `Approval assignee must be { user: "<email>" } or { team: "<name>" }, up to ${MAX_ASSIGNEE_LENGTH} characters.`,
        };
      }
    }

    return {
      invalid: false,
      payload:
        suspend.approval === true
          ? { reason: "approval", assignee, details, stepKey, until }
          : { reason: "event", details, stepKey, until },
    };
  }

  return {
    invalid: true,
    message: "Suspend payload reason must be sleep, child, event, or claim.",
  };
}

function parseAssigneeRequest(value: unknown): AssigneeRequest | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  const named = typeof value.user === "string" ? value.user : value.team;
  if (typeof named !== "string") return null;
  const trimmed = named.trim();
  if (trimmed === "" || trimmed.length > MAX_ASSIGNEE_LENGTH) return null;
  return "user" in value ? { user: trimmed } : { team: trimmed };
}

function parseSuspendStepKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    return null;
  }
  return value;
}

export function createSuspendFailure(input: {
  readonly code: AutomationRunFailure["code"];
  readonly execution: AutomationRunSuccess;
  readonly message: string;
  readonly run: PlatformRunRecord;
}): AutomationRunFailure {
  return {
    cause: null,
    code: input.code,
    durationMs: input.execution.durationMs,
    exitCode: input.execution.exitCode,
    message: input.message,
    payload: input.run.payload,
    runId: input.run.runId,
    signal: null,
    stack: null,
    stderr: input.execution.stderr,
    stdout: input.execution.stdout,
    success: false,
  };
}

type SuspensionInput = {
  readonly executionNumber: number;
  readonly execution: AutomationRunSuccess;
  readonly finishedAt: string;
  readonly payload: SuspendPayload;
  readonly rateLimitUsage: ReadonlyMap<string, number>;
  readonly run: PlatformRunRecord;
  readonly store: ControlPlaneStore;
};

interface SuspensionPlan {
  readonly wait: RunWait;
  readonly afterWaiting: () => Promise<ProcessRunOutcome>;
}

export async function handleSuspendedRunExecution(
  input: SuspensionInput,
): Promise<ProcessRunOutcome> {
  const plan = await prepareSuspension(input);
  if ("run" in plan) return plan;

  await input.store.completeRunExecution({
    executionNumber: input.executionNumber,
    durationMs: input.execution.durationMs,
    finishedAt: input.finishedAt,
    metadata: {
      exitCode: input.execution.exitCode,
      ...(input.execution.phases !== undefined ? { phases: input.execution.phases } : {}),
      rateLimitUsage: Object.fromEntries(input.rateLimitUsage),
    },
    runId: input.run.runId,
    status: "suspended",
    stderr: input.execution.stderr,
    stdout: input.execution.stdout,
    wait: { reason: input.payload.reason, stepKey: input.payload.stepKey },
  });

  await input.store.updateRunState({
    deadLetterReason: null,
    errorCause: null,
    errorClassification: null,
    errorCode: null,
    errorMessage: null,
    errorStack: null,
    runId: input.run.runId,
    status: "waiting",
    stderr: input.execution.stderr,
    stdout: input.execution.stdout,
    wait: plan.wait,
  });

  // updateRunState is a silent no-op when the run went terminal (cancel race
  // after the attempt was marked suspended). Only proceed to side effects such
  // as child creation when the waiting transition actually took effect.
  const suspendedRun = await getRunOrThrow(input.store, input.run.runId);
  if (suspendedRun.status !== "waiting") {
    return {
      run: suspendedRun,
      shouldRetry: false,
    };
  }

  return await plan.afterWaiting();
}

/** Dispatch once; the plan closes over prerequisites specific to this reason. */
async function prepareSuspension(
  input: SuspensionInput,
): Promise<SuspensionPlan | ProcessRunOutcome> {
  const payload = input.payload;
  const waiting = async (): Promise<ProcessRunOutcome> => ({
    run: await getRunOrThrow(input.store, input.run.runId),
    shouldRetry: false,
  });
  switch (payload.reason) {
    case "sleep":
      return { wait: payload, afterWaiting: waiting };
    case "event":
      return { wait: { ...payload, startedAt: input.finishedAt }, afterWaiting: waiting };
    case "claim":
      return {
        wait: payload,
        afterWaiting: () => resumeAfterClaim({ ...input, stepKey: payload.stepKey }),
      };
    case "child":
      return await prepareChildSuspension(input, payload);
    case "approval": {
      const assignee =
        payload.assignee === null
          ? null
          : await input.store.resolveApprovalAssignee(payload.assignee);
      if (payload.assignee !== null && assignee === null) {
        const request = payload.assignee;
        return await failBeforeWaiting(
          input,
          "APPROVAL_ASSIGNEE_NOT_FOUND",
          "user" in request
            ? `No person with the email ${request.user} has an account here, so nobody could decide the approval ${payload.stepKey}.`
            : `No team named ${request.team} exists here, so nobody could decide the approval ${payload.stepKey}.`,
        );
      }
      return { wait: { ...payload, assignee, startedAt: input.finishedAt }, afterWaiting: waiting };
    }
  }
}

async function failBeforeWaiting(
  input: SuspensionInput,
  code: AutomationRunFailure["code"],
  message: string,
): Promise<ProcessRunOutcome> {
  return await handleFailedRunExecution({
    ...input,
    execution: createSuspendFailure({ code, execution: input.execution, message, run: input.run }),
  });
}

async function prepareChildSuspension(
  input: SuspensionInput,
  payload: Extract<SuspendPayload, { reason: "child" }>,
): Promise<SuspensionPlan | ProcessRunOutcome> {
  const deployment = await input.store.getActiveDeploymentBySlug(
    createDisplayName(payload.automation),
    input.run.environment,
  );
  if (deployment === null)
    return await failBeforeWaiting(
      input,
      "INVOKE_TARGET_NOT_FOUND",
      `Invoke target not found in environment ${input.run.environment}: ${payload.automation}`,
    );
  const invokeDepth = input.run.invokeDepth + 1;
  if (invokeDepth > MAX_INVOKE_DEPTH)
    return await failBeforeWaiting(
      input,
      "INVOKE_DEPTH_EXCEEDED",
      `Invoke depth ${invokeDepth} exceeds the limit of ${MAX_INVOKE_DEPTH}.`,
    );
  return {
    wait: { reason: "child", stepKey: payload.stepKey },
    afterWaiting: async () => {
      try {
        const childRun = await persistRunFromDeployment({
          deployment,
          invokeDepth,
          parentRunId: input.run.runId,
          parentStepKey: payload.stepKey,
          payload: payload.payload,
          store: input.store,
          triggerType: "chain",
        });
        if (isFinishedRun(childRun.status)) {
          await resumeParentAfterChildTerminal({
            childRun,
            store: input.store,
          });
        }
        // Close the remaining cancel-race window: if the parent went terminal
        // while the child was being created, the cancel cascade could not have
        // seen this child yet. Cancel it here instead of leaving orphan work.
        const parentAfterChild = await getRunOrThrow(input.store, input.run.runId);
        if (isFinishedRun(parentAfterChild.status) && !isFinishedRun(childRun.status)) {
          await input.store.updateRunState({
            deadLetterReason: "parent-cancelled",
            errorClassification: "terminal",
            errorCode: "RUN_CANCELLED",
            errorMessage: "Parent run was cancelled while the child run was being created.",
            finishedAt: new Date().toISOString(),
            runId: childRun.runId,
            status: "dead-lettered",
          });
        }
      } catch (error) {
        return await deadLetterSuspended(input, error);
      }
      return { run: await getRunOrThrow(input.store, input.run.runId), shouldRetry: false };
    },
  };
}

async function deadLetterSuspended(
  input: Pick<SuspensionInput, "execution" | "run" | "store">,
  error: unknown,
): Promise<ProcessRunOutcome> {
  const runtimeError =
    error instanceof AutomationRuntimeError
      ? error
      : new AutomationRuntimeError("UNEXPECTED_RUNTIME_ERROR", getErrorMessage(error), {
          cause: error instanceof Error ? error : undefined,
        });
  await input.store.updateRunState({
    deadLetterReason: "suspend-failed",
    errorCause: serializeErrorCause(runtimeError.cause ?? error),
    errorClassification: "terminal",
    errorCode: runtimeError.code,
    errorMessage: runtimeError.message,
    errorStack: runtimeError.stack ?? null,
    finishedAt: new Date().toISOString(),
    runId: input.run.runId,
    status: "dead-lettered",
    stderr: input.execution.stderr,
    stdout: input.execution.stdout,
    wait: null,
  });
  return {
    classification: "terminal",
    run: await getRunOrThrow(input.store, input.run.runId),
    shouldRetry: false,
  };
}

/**
 * Claims the state key `stepKey` for the run and queues the run again with `{ claimed }` as the
 * step's result, all in the transaction that ends the execution. The run waits at the claim
 * only inside that transaction. A claim the state limit refuses, or a claim step that already
 * finished in this run, fails the run instead of leaving it waiting.
 */
async function resumeAfterClaim(input: {
  readonly execution: AutomationRunSuccess;
  readonly run: PlatformRunRecord;
  readonly stepKey: string;
  readonly store: ControlPlaneStore;
}): Promise<ProcessRunOutcome> {
  const fail = async (errorCode: AutomationRuntimeErrorCode, errorMessage: string) =>
    await deadLetterSuspended(input, new AutomationRuntimeError(errorCode, errorMessage));
  let claimed: boolean;
  try {
    claimed = await input.store.claimAutomationStateKey({
      automationId: input.run.automationId,
      environment: input.run.environment,
      key: input.stepKey,
      runId: input.run.runId,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof CodedError && error.code === "AUTOMATION_STATE_LIMIT_EXCEEDED")
      return await fail(error.code, error.message);
    throw error;
  }
  const resumed = await input.store.resumeWaitingRun({
    expectedWaitReason: "claim",
    result: { value: { claimed } },
    runId: input.run.runId,
    stepKey: input.stepKey,
  });
  if (resumed === null)
    return await fail(
      "SUSPEND_PAYLOAD_INVALID",
      `Step ${input.stepKey} already has a result; a run claims a key once.`,
    );
  return { run: resumed, shouldRetry: false };
}
