import type { AutomationConfig, StepSite } from "@swizzle/config";
import type { RunStatus } from "@swizzle/events";

export type PlatformRunStatus = RunStatus;

export type PlatformRunExecutionStatus =
  | "running"
  | "succeeded"
  | "suspended"
  | "retrying"
  | "failed"
  | "dead-lettered";

export type ErrorClassification = "retryable" | "terminal";

export type PlatformTriggerType = "chain" | "cron" | "webhook";

/** What started a run: its trigger firing, or a person starting it by hand. */
export type RunTriggerType = PlatformTriggerType | "manual";

export type PlatformTriggerStatus = "active" | "invalid" | "paused";

export type StoredArtifactStorageBackend = "local" | "s3";

export type StoredArtifactLocator =
  | {
      readonly artifactsDirectory: string;
      readonly relativeRootPath: string;
      readonly type: "local";
    }
  | {
      readonly bucket: string;
      readonly endpoint: string | null;
      readonly forcePathStyle: boolean;
      readonly keyPrefix: string;
      readonly region: string;
      readonly type: "s3";
    };

export type NotificationChannel = "telegram";

export type NotificationEventType = "dead-lettered" | "repeated-failures";

/**
 * What a delivery reported. Rules name a run event; every enabled rule of an automation also
 * delivers its API alerts: a check that starts failing, and an API's retirement notice.
 */
export type NotificationDeliveryEventType = NotificationEventType | "api-check" | "api-sunset";

export type NotificationDeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export type MaintenanceRunStatus = "succeeded" | "failed";

export type StoredRuntimeSnapshot = AutomationConfig["runtime"];

export interface StoredBuildStep {
  readonly kind: "node-dependencies" | "python-requirements";
  readonly lockfilePath: string | null;
  readonly logPath: string | null;
  readonly manifestPath: string;
  readonly outputPath: string | null;
  readonly packageManager: string | null;
  readonly status: "not-required" | "packaged";
}

export interface StoredBuildSnapshot {
  readonly stepSites: readonly StepSite[];
  readonly format?: "raw-source-v1" | undefined;
  readonly packagedAt: string;
  readonly status: "not-required" | "packaged";
  readonly steps: readonly StoredBuildStep[];
}

export const RUN_EXECUTION_PHASES = ["preparing", "executing"] as const;
export type RunExecutionPhase = (typeof RUN_EXECUTION_PHASES)[number];
