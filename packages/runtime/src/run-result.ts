import type { AutomationRuntimeErrorCode } from "./errors.js";

export interface RuntimeMetadata {
  readonly automationId?: string;
  readonly automationName?: string;
  readonly parentRunId?: string;
  readonly version?: string;
  readonly versionId?: string;
}

export interface RunPhases {
  readonly image?: number;
  readonly sandbox?: number;
  readonly standby?: boolean;
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
