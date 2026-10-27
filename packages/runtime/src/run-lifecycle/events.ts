import type {
  ControlPlaneStore,
  ExecutionLease,
  RunStepTotals,
  StepResultInput,
  StoredRunExecution,
} from "@swizzle/db";
import { stepResultBytes } from "@swizzle/db";
import { readStructuredEvents } from "../api-signals.js";
import { AutomationRuntimeError } from "../errors.js";
import type { PlatformRunRecord } from "../platform-types.js";
import { executionOf, type RunStepEvent } from "./records.js";

const MAX_STEP_VALUE_BYTES = 64 * 1024;

const MAX_TOTAL_STEP_BYTES = 5 * 1024 * 1024;

/** Rows per run: a stream of starts with no results must not grow run_steps without end. */
const MAX_RUN_STEPS = 2_000;

/**
 * Applies the state and step events on the complete lines of a run execution's stderr, one after
 * another, and returns the unfinished line. The first event that fails stops the rest; it ends
 * the attempt.
 */
export async function applyRunEvents(input: {
  readonly chunk: string;
  readonly lease: Pick<ExecutionLease, "executionNumber">;
  readonly line: string;
  readonly onStep?: (event: RunStepEvent) => void;
  readonly run: Pick<PlatformRunRecord, "automationId" | "environment" | "runId"> & {
    readonly executions: readonly Pick<StoredRunExecution, "attempt" | "executionNumber">[];
  };
  readonly store: ControlPlaneStore;
}): Promise<{ readonly line: string; readonly failed: { readonly error: unknown } | null }> {
  const events: Record<string, unknown>[] = [];
  const line = readStructuredEvents(input.line, input.chunk, (event) => {
    if (["state_set", "state_delete", "step_start", "step_result"].includes(event.type))
      events.push(event);
  });
  const step = {
    attempt: executionOf(input.run, input.lease).attempt,
    executionNumber: input.lease.executionNumber,
    ...(input.onStep !== undefined ? { onStep: input.onStep } : {}),
    runId: input.run.runId,
    store: input.store,
  };
  const state = {
    automationId: input.run.automationId,
    environment: input.run.environment,
    store: input.store,
  };
  for (const event of events) {
    try {
      if (event.type === "state_set") await applyStateSetEvent({ ...state, event });
      if (event.type === "state_delete") await applyStateDeleteEvent({ ...state, event });
      if (event.type === "step_start") await applyStepStartEvent({ ...step, event });
      if (event.type === "step_result") await applyStepResultEvent({ ...step, event });
    } catch (error) {
      return { line, failed: { error } };
    }
  }
  return { line, failed: null };
}

async function applyStateSetEvent(input: {
  readonly automationId: string;
  readonly environment: string;
  readonly event: Record<string, unknown>;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  const key = validateStateKey(input.event.key);
  if (!Object.hasOwn(input.event, "value")) {
    throw new AutomationRuntimeError(
      "AUTOMATION_STATE_LIMIT_EXCEEDED",
      `State event for key "${key}" is missing a JSON value.`,
      { details: { key } },
    );
  }
  await input.store.setAutomationStateValue({
    automationId: input.automationId,
    environment: input.environment,
    key,
    updatedAt: new Date().toISOString(),
    value: input.event.value,
  });
}

async function applyStateDeleteEvent(input: {
  readonly automationId: string;
  readonly environment: string;
  readonly event: Record<string, unknown>;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  const key = validateStateKey(input.event.key);
  await input.store.deleteAutomationStateValue({
    automationId: input.automationId,
    environment: input.environment,
    key,
  });
}

async function applyStepStartEvent(input: {
  readonly attempt: number;
  readonly executionNumber: number;
  readonly event: Record<string, unknown>;
  readonly onStep?: (event: RunStepEvent) => void;
  readonly runId: string;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  const stepKey = validateStepKey(input.event.key);
  assertStepCountWithinLimit(
    await input.store.getRunStepTotals({ runId: input.runId, stepKey }),
    stepKey,
  );
  const startedAt = new Date().toISOString();
  const entry = await input.store.startRunStep({
    executionNumber: input.executionNumber,
    runId: input.runId,
    startedAt,
    stepKey,
  });
  // A step that already has its result keeps it; nothing moved.
  if (entry.finishedAt !== null) return;
  input.onStep?.({
    attempt: input.attempt,
    executionNumber: input.executionNumber,
    key: stepKey,
    status: "started",
    timestamp: startedAt,
  });
}

async function applyStepResultEvent(input: {
  readonly attempt: number;
  readonly executionNumber: number;
  readonly event: Record<string, unknown>;
  readonly onStep?: (event: RunStepEvent) => void;
  readonly runId: string;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  const stepKey = validateStepKey(input.event.key);
  if (!Object.hasOwn(input.event, "value")) {
    throw new AutomationRuntimeError(
      "AUTOMATION_STEP_LIMIT_EXCEEDED",
      `Step result event for key "${stepKey}" is missing a JSON value.`,
      { details: { stepKey } },
    );
  }
  assertJsonSerializableStepValue(stepKey, input.event.value);
  const totals = await input.store.getRunStepTotals({ runId: input.runId, stepKey });
  // First write wins: the first persisted result is the memoized truth for this
  // run, so a duplicate step_result event must not overwrite it.
  if (totals.step !== null && totals.step.finishedAt !== null) return;
  assertStepCountWithinLimit(totals, stepKey);
  assertStepWriteWithinLimits({ result: { value: input.event.value }, stepKey, totals });
  const entry = await input.store.setRunStepResult({
    executionNumber: input.executionNumber,
    runId: input.runId,
    stepKey,
    value: input.event.value,
  });
  input.onStep?.({
    attempt: input.attempt,
    executionNumber: input.executionNumber,
    key: stepKey,
    status: "done",
    timestamp: entry.finishedAt ?? new Date().toISOString(),
  });
}

function validateStateKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new AutomationRuntimeError(
      "AUTOMATION_STATE_LIMIT_EXCEEDED",
      "State keys must be non-empty strings up to 255 characters.",
    );
  }
  return value;
}

function validateStepKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new AutomationRuntimeError(
      "AUTOMATION_STEP_LIMIT_EXCEEDED",
      "Step keys must be non-empty strings up to 255 characters.",
    );
  }
  return value;
}

function assertJsonSerializableStepValue(stepKey: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new AutomationRuntimeError(
      "AUTOMATION_STEP_LIMIT_EXCEEDED",
      `Step result "${stepKey}" must be JSON-serializable.`,
      { details: { stepKey } },
    );
  }
}

/** A new key may not take the run past MAX_RUN_STEPS rows; a known key restarts or completes freely. */
function assertStepCountWithinLimit(totals: RunStepTotals, stepKey: string): void {
  if (totals.steps < MAX_RUN_STEPS || totals.step !== null) return;
  throw new AutomationRuntimeError(
    "AUTOMATION_STEP_LIMIT_EXCEEDED",
    `Step "${stepKey}" would be the run's step ${totals.steps + 1}; max is ${MAX_RUN_STEPS} steps.`,
    { details: { limitSteps: MAX_RUN_STEPS, stepKey } },
  );
}

/** The result, and the run's results with it, for a step that has none yet. */
export function assertStepWriteWithinLimits(input: {
  readonly result: StepResultInput;
  readonly stepKey: string;
  readonly totals: RunStepTotals;
}): void {
  const valueBytes = stepResultBytes(input.result);
  if (valueBytes > MAX_STEP_VALUE_BYTES) {
    throw new AutomationRuntimeError(
      "AUTOMATION_STEP_LIMIT_EXCEEDED",
      `Step result "${input.stepKey}" is ${valueBytes} bytes; max is ${MAX_STEP_VALUE_BYTES} bytes.`,
      { details: { limitBytes: MAX_STEP_VALUE_BYTES, stepKey: input.stepKey, valueBytes } },
    );
  }

  const totalBytes = input.totals.resultBytes + valueBytes;
  if (totalBytes > MAX_TOTAL_STEP_BYTES) {
    throw new AutomationRuntimeError(
      "AUTOMATION_STEP_LIMIT_EXCEEDED",
      `Run step results would be ${totalBytes} bytes; max is ${MAX_TOTAL_STEP_BYTES} bytes.`,
      { details: { limitBytes: MAX_TOTAL_STEP_BYTES, stepKey: input.stepKey, totalBytes } },
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
