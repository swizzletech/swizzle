// The records the platform produces that the API's responses embed: deployments, runs, readiness,
// credential health and diagnoses. They hold data only and import types only, so
// http-contract.ts names them without loading the code that builds them; the dashboard
// type-checks everything the contract reaches. A record a response embeds belongs here.

import type { AutomationRuntimeConfig, WorkerService } from "@swizzle/config";
import type {
  ConnectionView,
  CredentialState,
  DeclaredConnectionStatus,
  DeleteAutomationCounts,
  DeleteProjectResult,
  DeploymentChange,
  ExplainedPlacement,
  KeptAutomationHistory,
  StoredDeployment,
  StoredRun,
  WorkerCapabilities,
} from "@swizzle/db";

import type { ArtifactStorageReadinessResult } from "./storage/types.js";

export interface PlatformDeploymentRecord extends StoredDeployment {
  readonly connectionHealth: readonly PlatformConnectionStatusRecord[];
  readonly readiness: RuntimeReadinessReport;
  readonly secretHealth: readonly PlatformSecretStatusRecord[];
}

/** The decision apply made, alongside its deployment. Reads have no action. */
export interface PlatformApplyResult extends PlatformDeploymentRecord {
  readonly action: PlatformDeploymentCheck["action"];
  readonly changes: readonly DeploymentChange[];
  readonly message: string | null;
}

export type { DeploymentChange } from "@swizzle/db";

/** A run as `getPlatformRun` reads it for the API, `swizzle diagnose` and the run panel. */
export type PlatformRunDetail = StoredRun & {
  /**
   * Why a queued run waits for a worker and until when, in the words every surface prints. Null
   * unless the run is queued, and in tests that execute a run directly.
   */
  readonly placement: ExplainedPlacement | null;
};

/** A deleted project, with the first error removing a deleted automation's artifacts. */
export interface DeleteProjectResultRecord
  extends Omit<DeleteProjectResult, "deletedAutomations" | "deletedConnections"> {
  readonly artifactError: string | null;
}

/** A run a person started by hand, with what the trigger noticed on the way. */
export interface ManualTriggerRunRecord extends StoredRun {
  readonly warning?: string;
}

export interface CancelRunResult {
  readonly run: StoredRun;
  readonly alreadyTerminal: boolean;
}

export interface PlatformReadinessReport {
  readonly checks: {
    readonly artifactStorage: ArtifactStorageReadinessResult;
    readonly database: { readonly error?: string; readonly ok: boolean };
    readonly queue: { readonly error?: string; readonly ok: boolean };
  };
  readonly ok: boolean;
}

// Readiness: whether workers can run a deployment, from runtime-requirements.ts.

export interface RuntimeRequirementIssue {
  readonly code:
    | "BINARY_REQUIREMENT_MISSING"
    | "BINARY_VERSION_UNSUPPORTED"
    | "CONNECTION_NOT_ACTIVE"
    | "CONTAINER_DOCKER_UNAVAILABLE"
    | "CONTAINER_EXECUTION_UNSUPPORTED"
    | "DEPENDENCY_MANIFEST_MISSING"
    | "LANGUAGE_RUNTIME_UNAVAILABLE"
    | "NODE_LOCKFILE_MISSING"
    | "RUNTIME_CONTAINER_LIMIT_EXCEEDS_MAX"
    | "RUNTIME_TIMEOUT_EXCEEDS_MAX"
    | "RUNNER_IMAGE_INVENTORY_UNAVAILABLE"
    | "RUNTIME_PROFILE_UNAVAILABLE"
    | "RUNTIME_SERVICE_NOT_GRANTED"
    | "SECRET_MISSING"
    | "TRIGGER_CONFIGURATION_INVALID"
    | "TIMEOUT_FORMAT_INVALID";
  readonly message: string;
  readonly subject?: string | undefined;
  /** The name of the worker a gap belongs to; absent on issues of the automation itself. */
  readonly worker?: string | undefined;
}

export interface RuntimeReadinessReport {
  readonly availableProfiles: readonly string[];
  readonly checkedAt: string;
  readonly compatibleWorkerInstanceIds: readonly string[];
  readonly errors: readonly RuntimeRequirementIssue[];
  readonly executionMode: AutomationRuntimeConfig["execution_mode"];
  readonly language: AutomationRuntimeConfig["language"];
  readonly matchingWorkerCount: number;
  readonly profile: string;
  readonly queueName: string;
  readonly status: "ready" | "not-ready";
  readonly warnings: readonly RuntimeRequirementIssue[];
}

interface WorkerRuntimeProfile {
  readonly name: string;
  readonly queueName: string;
}

/**
 * A worker as deploy readiness judges it: its groups and services from the registry, and the
 * capabilities its last heartbeat reported. An offline worker counts with its grants only.
 */
export interface ReadinessWorker {
  /** A selected image that this worker could not inspect, never a default-image fallback. */
  readonly runnerImageError?: string;
  readonly availability: "online" | "offline";
  readonly capabilities: WorkerCapabilities;
  readonly concurrency: number;
  readonly instanceId: string;
  /** The worker's name in Settings > Workers, which readiness messages name it by. */
  readonly name: string;
  readonly profiles: readonly WorkerRuntimeProfile[];
  /** The services an owner or admin granted it. */
  readonly services: readonly WorkerService[];
}

// Credential health and connection authorization, from platform-connections.ts and
// platform-secrets.ts.

export interface PlatformConnectionStatusRecord {
  readonly accessTokenExpiresAt: string | null;
  readonly environment: string;
  readonly lastErrorCode: string | null;
  readonly name: string;
  readonly provider: string | null;
  readonly status: DeclaredConnectionStatus;
}

export interface PlatformSecretStatusRecord {
  readonly algorithm: string | null;
  readonly createdAt: string | null;
  readonly environment: string;
  readonly keyVersion: string | null;
  readonly name: string;
  readonly state: CredentialState;
  readonly secretVersion: number | null;
  readonly updatedAt: string | null;
}

export interface BeginConnectionAuthorizationResult {
  readonly authorizationUrl: string;
  readonly connection: ConnectionView;
  readonly expiresAt: string;
  readonly redirectUri: string;
}

export interface TestConnectionResult {
  readonly accessTokenExpiresAt: string | null;
  readonly connection: ConnectionView;
  readonly refreshed: boolean;
}

// Why a run ended as it did, from run-diagnosis.ts.

export interface DiagnosisEvidence {
  readonly kind: string;
  readonly detail: string;
}

export interface DiagnosisFix {
  readonly command?: string;
  readonly confidence: number;
  readonly rationale: string;
}

export interface Diagnosis {
  readonly runId: string;
  readonly automation: string | null;
  readonly status: string;
  readonly triggerType: string;
  readonly attempts: { readonly made: number; readonly max: number };
  readonly likelyCause: { readonly code: string; readonly summary: string };
  readonly evidence: readonly DiagnosisEvidence[];
  readonly suggestedFixes: readonly DiagnosisFix[];
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly deadLetterReason: string | null;
  readonly stderrTail: string | null;
}

export interface DeleteAutomationResultRecord {
  readonly artifactError: string | null;
  readonly artifactsRemoved: boolean;
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly deletedCounts: DeleteAutomationCounts;
  readonly environment: string;
  readonly kept: KeptAutomationHistory;
  readonly projectId: string;
}

/** What a deployment would do, after every check apply makes; see `checkDeployment`. */
export interface PlatformDeploymentCheck {
  readonly changes: readonly DeploymentChange[];
  readonly action: "create" | "update" | "noop";
  readonly automationName: string;
  readonly environment: string;
  readonly projectId: string;
  /** The normalized path of its webhook trigger; null for another trigger. */
  readonly webhookPath: string | null;
  /** What the workers serving its project say; apply refuses it unless ready or forced. */
  readonly readiness: RuntimeReadinessReport;
}
