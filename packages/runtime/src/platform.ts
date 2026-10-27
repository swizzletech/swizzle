// The runtime's platform services: the queue-backed API, scheduler and worker services, run logs,
// leader election and maintenance. They hold Valkey clients and open Postgres stores, so only the
// services load this entry. Request and response types are in @swizzle/runtime/http-contract;
// runtime helpers use src/index.ts.

export { connectionResponse, deploymentResponse, runResponse } from "./api-views.js";
export {
  listRegisteredReadinessWorkers,
  type RegisteredReadinessWorker,
} from "./deployment-admin.js";
export { createServerDispatch, type ServerDispatch } from "./dispatch-service.js";
export { localExecutionProtocol } from "./execution-protocol.js";
export { executeAssignment } from "./execution-wire.js";
export { createLeaderLock, type LeaderLock } from "./leader-lock.js";
export { localLlmHealth } from "./local-llm-access.js";
export { type RunLogEvent, subscribeRunLogEvents } from "./log-stream.js";
export type {
  DeleteAutomationResultRecord,
  PlatformConnectionStatusRecord,
  PlatformDeploymentRecord,
  PlatformRunDetail,
  PlatformSecretStatusRecord,
} from "./platform-records.js";
export { createPlatformServices } from "./platform-services.js";
export type {
  OpenWaitRecord,
  PlatformDeployOptions,
  PlatformLogger,
  PlatformMaintenanceRunRecord,
  PlatformNotificationDeliveryRecord,
  PlatformQueueMetricSampleRecord,
  PlatformRunRecord,
  PlatformRunStatus,
  PlatformServices,
  PlatformWorkerController,
} from "./platform-types.js";
export { resolveWaitingEventRun } from "./run-lifecycle.js";
export type { RunQueueProducer } from "./run-queue.js";
export { createBullMqConnection } from "./run-queue.js";
export { startPlatformWorkerService } from "./worker-service.js";
export {
  type ExecutionAssignment,
  type ExecutionReport,
  readWorkerReply,
  WORKER_ROUTES,
  type WorkerRoute,
  workerBodySchema,
} from "./worker-wire.js";
