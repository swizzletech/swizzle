import type { AutomationRuntimeErrorCode } from "./errors.js";

// The outcome of one automation run. Both the host-process runner and the container runner
// produce it, so it lives apart from either.

export interface RuntimeMetadata {
  readonly automationId?: string;
  readonly automationName?: string;
  readonly parentRunId?: string;
  readonly version?: string;
  readonly versionId?: string;
}

/**
 * Where a sandboxed run spent its time, in milliseconds. The worker stores it in the attempt's
 * metadata; `just perf` reports it.
 */
export interface RunPhases {
  /** Assembling the run image, or waiting for an assembly in progress. Absent when it was ready. */
  readonly image?: number;
  /** Getting a started sandbox: a standby's remaining start, or creating and starting one. */
  readonly sandbox?: number;
  /** Whether the sandbox was a standby, started before the run asked for it. */
  readonly standby?: boolean;
  /** Staging the inputs and running the automation until it exited. */
  readonly process?: number;
}

export interface AutomationRunSuccess {
  readonly durationMs: number;
  readonly exitCode: 0;
  readonly payload: unknown;
  readonly phases?: RunPhases;
  readonly result: unknown;
  readonly runId: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly success: true;
}

export interface AutomationRunFailure {
  readonly cause?: string | null;
  readonly code: AutomationRuntimeErrorCode;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly message: string;
  readonly payload: unknown | undefined;
  readonly phases?: RunPhases;
  readonly runId: string | undefined;
  readonly signal: NodeJS.Signals | null;
  readonly stack?: string | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly success: false;
}

export type AutomationRunResult = AutomationRunSuccess | AutomationRunFailure;
