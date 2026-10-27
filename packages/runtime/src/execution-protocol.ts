import type { AutomationRunResult } from "./run-result.js";
import type { ExecutionOptions, RunAutomationOptions } from "./runner.js";

/** Execution knows scripts and streams. Database orchestration stays with the caller. */
export interface ExecutionProtocol {
  run(options: RunAutomationOptions): Promise<AutomationRunResult>;
  check(options: ExecutionOptions): Promise<AutomationRunResult>;
}

import { runAutomation, runAutomationCheck } from "./runner.js";

/** The machine adapter. Both kinds of deployed execution enter through this protocol. */
export const localExecutionProtocol: ExecutionProtocol = {
  run: runAutomation,
  check: runAutomationCheck,
};
