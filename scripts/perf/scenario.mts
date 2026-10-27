// Persist only known nonsecret settings from Compose's resolved configuration. Project names,
// ports and credentials vary per throwaway stack and must never become result metadata.
import type { PerfResult } from "./result.ts";

const ENVIRONMENT = new Set([
  "SCHEDULER_INTERVAL_MS",
  "SCHEDULER_MAINTENANCE_INTERVAL_MS",
  "NODE_ENV",
  "LOG_LEVEL",
  "SWIZZLE_ENVIRONMENT",
  "SWIZZLE_MAX_RUN_TIMEOUT",
  "SWIZZLE_MAX_RUN_MEMORY_MB",
  "SWIZZLE_MAX_RUN_CPUS",
  "SWIZZLE_SHUTDOWN_TIMEOUT_MS",
  "SWIZZLE_ARTIFACT_BACKEND",
  "SWIZZLE_ARTIFACT_S3_BUCKET",
  "SWIZZLE_ARTIFACT_S3_REGION",
  "SWIZZLE_ARTIFACT_S3_PREFIX",
  "SWIZZLE_ARTIFACT_S3_FORCE_PATH_STYLE",
  "SWIZZLE_REQUIRE_SANDBOX",
  "SWIZZLE_WEBHOOK_INGRESS_RATE_LIMIT",
  "SWIZZLE_TRUSTED_PROXY",
  "SWIZZLE_RUNNER_IMAGE_RETENTION_HOURS",
  "SWIZZLE_RUNNER_IMAGE_DISK_MB",
  "SWIZZLE_NOTIFICATION_DELIVERY_RETENTION_DAYS",
  "SWIZZLE_QUEUE_METRIC_RETENTION_DAYS",
  "SWIZZLE_HEARTBEAT_RETENTION_HOURS",
  "SWIZZLE_QUEUE_FAILED_RETENTION_HOURS",
  "SWIZZLE_RUN_RETENTION_DAYS",
  "SWIZZLE_ARTIFACT_RETENTION_DEPLOYMENTS",
]);
const RESOURCES = [
  "mem_limit",
  "mem_reservation",
  "memswap_limit",
  "cpus",
  "cpu_shares",
  "cpu_quota",
  "cpu_period",
  "cpuset",
  "pids_limit",
  "shm_size",
];

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid resolved Compose configuration");
  }
  return value as Record<string, unknown>;
}

/** Each session reads its own resolved Compose model, including shell overrides and defaults. */
export function stackScenario(json: string): PerfResult["scenario"] {
  const services = object(object(JSON.parse(json)).services);
  const worker = object(services.worker);
  const workerReplicas = Number(object(worker.deploy).replicas);
  const workerConcurrency = Number(object(worker.environment).WORKER_CONCURRENCY);
  if (
    ![workerReplicas, workerConcurrency].every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    throw new Error("Compose worker replicas and WORKER_CONCURRENCY must be positive integers");
  }
  const settings: Record<string, string | number> = {};
  const keep = (key: string, value: unknown) => {
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`Invalid Compose scenario setting ${key}`);
    }
    settings[key] = value;
  };
  for (const [name, value] of Object.entries(services).sort(([a], [b]) => a.localeCompare(b))) {
    const service = object(value);
    for (const key of RESOURCES) {
      if (service[key] !== undefined) keep(`${name}.${key}`, service[key]);
    }
    if (service.build === undefined && service.image !== undefined)
      keep(`${name}.image`, service.image);
    if (service.environment !== undefined) {
      for (const [key, value] of Object.entries(object(service.environment)).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (ENVIRONMENT.has(key)) keep(`${name}.${key}`, value);
      }
    }
  }
  return { ...settings, workerConcurrency, workerReplicas };
}
