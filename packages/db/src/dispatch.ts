import type {
  ApiContactObservation,
  ControlPlaneStore,
  StoredConnectionUsage,
  StoredNotificationDelivery,
  StoredRun,
  StoredSecretUsage,
} from "./control-plane-types.js";
import type { WorkerIdentity } from "./workers.js";

interface LeaseOwnership {
  readonly taskId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly executionNumber: number;
  readonly expiresAt: string;
  readonly remainingMs: number;
}

export type LeaseRef = Pick<LeaseOwnership, "taskId" | "generation">;

export type ExecutionLease = LeaseOwnership &
  (
    | { readonly runId: string; readonly checkId: null; readonly dueAt: null }
    | { readonly runId: null; readonly checkId: string; readonly dueAt: string }
  );

export interface ExecutionState {
  readonly secrets: Readonly<Record<string, string>>;
  readonly redacted: readonly string[];
  readonly sequence: number;
  readonly digest: string | null;
  readonly stdout: ExecutionStream;
  readonly stderr: ExecutionStream;
  readonly line: string;
  readonly signals: ExecutionSignals;
  readonly connectionUsages: readonly StoredConnectionUsage[];
  readonly secretUsages: readonly StoredSecretUsage[];
}
export interface ExecutionSignals {
  readonly contacts: Readonly<Record<string, Omit<ApiContactObservation, "host">>>;
  readonly rateLimitUsage: Readonly<Record<string, number>>;
}
export interface ExecutionStream {
  readonly bytes: number;
  readonly pending: string;
}
export interface LeaseScope {
  readonly store: ControlPlaneStore;
  readonly lease: ExecutionLease;
  readonly executionState: ExecutionState | null;
  save(state: ExecutionState): Promise<void>;
  release(resultDigest: string | null): Promise<void>;
}

export function nextExecution(run: Pick<StoredRun, "attemptsMade" | "executions">) {
  return {
    executionNumber: (run.executions.at(-1)?.executionNumber ?? 0) + 1,
    attempt: run.attemptsMade + 1,
  };
}

export interface LostExecution {
  readonly lease: ExecutionLease & { readonly runId: string };
  readonly started: boolean;
}

export interface ExpiredPlacement {
  readonly run: StoredRun;
  readonly projectName: string;
}

export interface DispatchStore {
  claim(
    identity: WorkerIdentity,
    runId: string,
    admit?: () => Promise<boolean>,
  ): Promise<ExecutionLease | null>;
  claimCheck(
    identity: WorkerIdentity,
    checkId: string,
    dueAt: string,
    admit?: () => Promise<boolean>,
  ): Promise<ExecutionLease | null>;
  renew(identity: WorkerIdentity, lease: LeaseRef): Promise<ExecutionLease>;
  start(identity: WorkerIdentity, lease: LeaseRef): Promise<ExecutionState>;
  access<T>(
    identity: WorkerIdentity,
    lease: LeaseRef,
    apply: (scope: LeaseScope) => Promise<T>,
  ): Promise<T>;
  completed(identity: WorkerIdentity, lease: LeaseRef, resultDigest: string): Promise<boolean>;
  reclaim(lose: (lost: LostExecution, store: ControlPlaneStore) => Promise<void>): Promise<void>;
  expirePlacements(
    fail: (expired: ExpiredPlacement, store: ControlPlaneStore) => Promise<void>,
  ): Promise<void>;
  drainTerminals(apply: (run: StoredRun, store: ControlPlaneStore) => Promise<void>): Promise<void>;
  drainNotifications(
    apply: (delivery: StoredNotificationDelivery, store: ControlPlaneStore) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}

export class ExecutionLeaseError extends Error {
  constructor() {
    super("Execution lease is expired, cancelled, revoked, or belongs to another generation.");
    this.name = "ExecutionLeaseError";
  }
}
