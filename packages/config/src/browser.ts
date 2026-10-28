/**
 * `@swizzle/config/browser`, the entry the dashboard imports: pure helpers with no `node:*`,
 * `yaml`, `zod` or `ajv` imports. `.dependency-cruiser.mjs` keeps the dashboard off the root
 * entry and keeps this module from reaching anything outside the package.
 */
export {
  type ApprovalDetailField,
  type ApprovalDetailsInWords,
  approvalDetailsInWords,
} from "./approval-details.js";
export { AUTOMATION_CONNECTION_NAME_PATTERN } from "./connection-name.js";
export {
  extractFlowNodeIds,
  type FlowDriftWarning,
  flowDrift,
  type StepKind,
  type StepSite,
  type StepSourceLanguage,
  scanStepSites,
  stepSourceLanguage,
} from "./flow-map.js";
export { formatIntervalMs } from "./intervals.js";
export { PASSWORD_LENGTH } from "./password.js";
export {
  LOCAL_LLM_SERVICE,
  WORKER_SERVICES,
  type WorkerService,
} from "./worker-services.js";
