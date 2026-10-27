import type { AutomationConfig } from "@swizzle/config";
import type { DeploymentAuditEventType, DeploymentDiff, TriggerAuditEventType } from "../audit.js";
import type {
  PlatformTriggerStatus,
  PlatformTriggerType,
  StoredArtifactLocator,
  StoredArtifactStorageBackend,
  StoredBuildSnapshot,
  StoredRuntimeSnapshot,
} from "./common.js";
import type { DeleteConnectionResult, DeploymentCredential } from "./credentials.js";

export interface RollbackDeploymentInput {
  readonly deploymentId: string;
  readonly environment: string;
  readonly targetDeploymentId: string;
}

export interface CommitDeploymentAuditInput {
  readonly eventType: DeploymentAuditEventType;
  readonly metadata?: Record<string, unknown>;
}

export interface CommitDeploymentInput {
  readonly auditEvent: CommitDeploymentAuditInput;
  /** What the deployment binds: one entry per declared secret and connection. */
  readonly credentials: readonly DeploymentCredential[];
  readonly deployment: PersistDeploymentInput;
  /** Redeploy unchanged content when forced or when credential bindings changed. */
  readonly intent: "deploy" | "redeploy-if-unchanged";
}

export interface CommitRollbackDeploymentInput {
  readonly auditEvent: CommitDeploymentAuditInput;
  readonly environment: string;
  readonly targetDeploymentId: string;
}

type CommitDeploymentAction = "create" | "noop" | "update";

export interface CommitDeploymentResult {
  readonly action: CommitDeploymentAction;
  readonly deployment: StoredDeployment;
  readonly message: string | null;
  readonly previousDeployment: StoredDeployment | null;
  readonly trigger: StoredTrigger | null;
}

export interface DeleteAutomationInput {
  readonly automationSlug: string;
  readonly environment: string;
}

/** What deleting an automation removed with it, in every environment (ADR 0015). */
export interface DeleteAutomationCounts {
  readonly deployments: number;
  readonly runs: number;
}

/** What outlives a deleted automation: its audit events, which have no foreign key. */
export interface KeptAutomationHistory {
  readonly auditEvents: number;
}

/**
 * What happens to a project's automations, credentials and runs when it is deleted (ADR 0015):
 * they move to another project, or they are deleted with it. Audit events stay either way.
 */
export type ProjectContents =
  | { readonly kind: "move"; readonly projectId: string }
  | { readonly kind: "delete" };

/** What a project holds that its deletion must decide about. */
export interface ProjectContentCounts {
  readonly automations: number;
  /** Secrets and connections, in every environment. */
  readonly credentials: number;
  readonly runs: number;
}

export interface DeleteProjectInput {
  readonly projectId: string;
  /**
   * Null deletes only an empty project; one that holds anything in ProjectContentCounts is
   * refused with PROJECT_NOT_EMPTY, whose details carry the counts.
   */
  readonly contents: ProjectContents | null;
}

export interface DeleteProjectResult {
  readonly projectId: string;
  readonly contents: ProjectContents["kind"] | "empty";
  /** What moved or was deleted, counted before the change. */
  readonly counts: ProjectContentCounts;
  /** Each deleted automation's artifact references, for the caller to remove its trees. */
  readonly deletedAutomations: readonly {
    readonly automationSlug: string;
    readonly artifactReferences: readonly DeleteAutomationArtifactRef[];
  }[];
  /** Each deleted connection, for the caller to revoke its token at the provider. */
  readonly deletedConnections: readonly DeleteConnectionResult[];
}

export interface MoveAutomationInput {
  readonly automationSlug: string;
  readonly projectId: string;
}

export interface DeleteAutomationArtifactRef {
  readonly artifactBackend: StoredArtifactStorageBackend;
  readonly artifactLocator: StoredArtifactLocator;
  readonly artifactRootPath: string;
}

export interface DeleteAutomationResult {
  readonly artifactReferences: readonly DeleteAutomationArtifactRef[];
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly deletedCounts: DeleteAutomationCounts;
  readonly kept: KeptAutomationHistory;
  readonly projectId: string;
}

export interface CreateDeploymentAuditEventInput {
  readonly automationId: string;
  readonly deploymentId: string;
  readonly diff?: DeploymentDiff | null;
  readonly environment: string;
  readonly eventType: DeploymentAuditEventType;
  readonly metadata?: Record<string, unknown>;
  readonly occurredAt: string;
  readonly previousDeploymentId?: string | null;
  readonly previousSourceHash?: string | null;
  readonly previousVersion?: string | null;
  readonly sourceHash: string;
  readonly version: string;
}

export interface StoredDeployment {
  readonly artifactBackend: StoredArtifactStorageBackend;
  readonly artifactLocator: StoredArtifactLocator;
  readonly artifactRootPath: string;
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly buildSnapshot: StoredBuildSnapshot;
  readonly config: AutomationConfig;
  readonly deployedAt: string;
  readonly deploymentId: string;
  readonly entrypoint: string;
  readonly environment: string;
  readonly manifestPath: string;
  /** The project the automation is in now: whose secrets its runs and checks receive. */
  readonly projectId: string;
  readonly runtimeSnapshot: StoredRuntimeSnapshot;
  readonly seq: number;
  readonly sourceDirectory: string;
  readonly sourceHash: string;
  readonly status: string;
  readonly triggerType: AutomationConfig["trigger"]["type"];
  readonly version: string;
  readonly versionId: string;
}

export interface StoredTrigger {
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly chainOnStatus: string | null;
  readonly chainPayloadMode: string | null;
  readonly chainSourceAutomationId: string | null;
  readonly chainSourceAutomationIds: readonly string[];
  readonly config: AutomationConfig;
  readonly cronIntervalMs: number | null;
  readonly cronSchedule: string | null;
  readonly deploymentId: string;
  readonly environment: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly nextRunAt: string | null;
  readonly pausedAt: string | null;
  /** The project the automation is in now: whose secrets sign its webhook. */
  readonly projectId: string;
  readonly status: PlatformTriggerStatus;
  readonly triggerId: string;
  readonly triggerType: PlatformTriggerType;
  readonly updatedAt: string;
  readonly versionId: string;
  readonly webhookPath: string | null;
}

export interface PersistDeploymentInput {
  /** The project a new automation joins; an existing one must already belong to it. */
  readonly projectId: string;
  readonly artifactBackend: StoredArtifactStorageBackend;
  readonly artifactLocator: StoredArtifactLocator;
  readonly artifactRootPath: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly buildSnapshot: StoredBuildSnapshot;
  readonly config: AutomationConfig;
  readonly deployedAt: string;
  readonly deploymentId: string;
  readonly environment: string;
  readonly entrypoint: string;
  readonly manifestPath: string;
  readonly runtimeSnapshot: StoredRuntimeSnapshot;
  readonly sourceDirectory: string;
  readonly sourceHash: string;
}

interface DeploymentTriggerIdentity {
  readonly automationId: string;
  readonly deploymentId: string;
  readonly environment: string;
  readonly updatedAt: string;
  readonly versionId: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export type DeploymentTriggerInput = DeploymentTriggerIdentity &
  (
    | {
        readonly triggerType: "webhook";
        readonly webhookPath: string;
      }
    | {
        readonly triggerType: "cron";
        readonly cronIntervalMs: number | null;
        readonly cronSchedule: string | null;
        readonly nextRunAt: string | null;
      }
    | {
        readonly triggerType: "chain";
        readonly chainOnStatus: string | null;
        readonly chainPayloadMode: string | null;
        readonly chainSourceAutomationId: string | null;
        readonly chainSourceAutomationIds: readonly string[];
      }
  );

export interface CreateTriggerAuditEventInput {
  readonly automationId: string;
  readonly deploymentId: string;
  readonly environment: string;
  readonly eventType: TriggerAuditEventType;
  readonly metadata?: Record<string, unknown>;
  readonly occurredAt: string;
  readonly runId?: string | null;
  readonly triggerId: string;
  readonly triggerType: PlatformTriggerType;
}

export interface UpdateTriggerStatusInput {
  readonly automationSlug: string;
  readonly environment: string;
  readonly status: Exclude<PlatformTriggerStatus, "invalid">;
  readonly updatedAt: string;
}

export interface AdvanceCronTriggerCursorInput {
  readonly expectedNextRunAt: string;
  readonly nextRunAt: string;
  readonly triggerId: string;
  readonly updatedAt: string;
}
