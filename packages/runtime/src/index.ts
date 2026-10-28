// The runtime's cheap entry: automation definitions, bundling, local and container runs, readiness,
// artifact storage and webhook context. Importing it opens no Valkey or Postgres client and loads
// neither library, so the CLI starts fast. The services that run on Valkey and Postgres are in
// `@swizzle/runtime/platform` (src/platform.ts); `just check` keeps them out of this entry.

export { placementInWords, runImageDiskWarning } from "@swizzle/db";
export {
  assertBackupDestinationFree,
  BackupError,
  backupPaths,
  createBackupMetadata,
  publishBackup,
  readBackup,
} from "./backup.js";
export {
  BundleEmptyError,
  BundleTooLargeError,
  bundleEntrypointDryRun,
  packAutomation,
} from "./bundle.js";
export { type CheckOutcome, checkOutcome } from "./check-contract.js";
export { containerLimitArguments } from "./container-limits.js";
export { isDockerAvailable } from "./container-runner.js";
export { deployAutomation } from "./deploy.js";
export { AutomationRuntimeError, type AutomationRuntimeErrorCode } from "./errors.js";
export { redactWaitLinks } from "./output-redaction.js";
export { findSamplePayloadFile, SAMPLE_PAYLOAD_FILE_NAME } from "./payload.js";
export type { Diagnosis, ReadinessWorker, RuntimeReadinessReport } from "./platform-records.js";
export { parseRateLimitSpec, type RateLimitConfig } from "./rate-limit-parser.js";
export {
  buildDiagnosis,
  type DiagnosableRun,
  type SecretHealthRecord,
} from "./run-diagnosis.js";
export type { AutomationRunFailure } from "./run-result.js";
export { runAutomation, runAutomationCheck } from "./runner.js";
export {
  addCredentialIssues,
  collectWorkerCapabilities,
  createQueueNameForProfile,
  evaluateAutomationReadiness,
  evaluateLocalAutomationReadiness,
  getDeclaredDependencyManifestPaths,
  readRunnerTools,
  servesProject,
} from "./runtime-requirements.js";
export {
  type ArtifactStorageBackend,
  createArtifactStorageForReference,
  createConfiguredArtifactStorage,
} from "./storage.js";
export { formatRuntimeTimeoutMs, parseRuntimeTimeout } from "./timeout-policy.js";
export { type AutomationDefinition, loadAutomationDefinition } from "./validation.js";
export {
  createWaitLinkToken,
  MAX_WAIT_LINK_TOKEN_LENGTH,
  type WaitLinkKind,
} from "./wait-links.js";
export { createWebhookRunContext, type WebhookRunContext } from "./webhook-context.js";
