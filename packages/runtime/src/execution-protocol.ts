import type { AutomationRunResult } from "./run-result.js";
import type { ExecutionOptions, RunAutomationOptions } from "./runner.js";

export interface ExecutionProtocol {
  run(options: RunAutomationOptions): Promise<AutomationRunResult>;
  check(options: ExecutionOptions): Promise<AutomationRunResult>;
}

import { runAutomation, runAutomationCheck } from "./runner.js";

export const localExecutionProtocol: ExecutionProtocol = {
  run: runAutomation,
  check: runAutomationCheck,
};
