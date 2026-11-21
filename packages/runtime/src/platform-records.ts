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
  PlatformRunStatus,
  RunState,
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

export interface PlatformApplyResult extends PlatformDeploymentRecord {
  readonly action: PlatformDeploymentCheck["action"];
  readonly changes: readonly DeploymentChange[];
  readonly message: string | null;
}

export type { DeploymentChange } from "@swizzle/db";

export type PlatformRunDetail = StoredRun & {
  readonly placement: ExplainedPlacement | null;
};

export interface DeleteProjectResultRecord
  extends Omit<DeleteProjectResult, "deletedAutomations" | "deletedConnections"> {
  readonly artifactError: string | null;
}

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
    | "RUNNER_IMAGE_REQUIREMENTS_UNVERIFIED"
    | "RUNTIME_PROFILE_UNAVAILABLE"
    | "RUNTIME_SERVICE_NOT_GRANTED"
    | "SECRET_MISSING"
    | "TRIGGER_CONFIGURATION_INVALID"
    | "TIMEOUT_FORMAT_INVALID";
  readonly message: string;
  readonly subject?: string | undefined;
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

export type RunnerImageResult =
  | { readonly kind: "ready"; readonly capabilities: WorkerCapabilities }
  | { readonly kind: "unverified" }
  | { readonly kind: "unavailable"; readonly message: string };

export interface ReadinessWorker {
  readonly runnerImage?: RunnerImageResult;
  readonly availability: "online" | "offline";
  readonly capabilities: WorkerCapabilities;
  readonly concurrency: number;
  readonly instanceId: string;
  readonly name: string;
  readonly profiles: readonly WorkerRuntimeProfile[];
  readonly services: readonly WorkerService[];
}

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
  readonly status: PlatformRunStatus;
  readonly state: RunState;
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

export interface PlatformDeploymentCheck {
  readonly changes: readonly DeploymentChange[];
  readonly action: "create" | "update" | "noop";
  readonly automationName: string;
  readonly environment: string;
  readonly projectId: string;
  readonly webhookPath: string | null;
  readonly readiness: RuntimeReadinessReport;
}
