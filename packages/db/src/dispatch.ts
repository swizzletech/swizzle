import type {
  ApiContactObservation,
  ControlPlaneStore,
  StoredConnectionUsage,
  StoredNotificationDelivery,
  StoredRun,
  StoredSecretUsage,
} from "./control-plane-types.js";
import type { WorkerIdentity } from "./workers.js";

/** The generation fences every write after a run changes hands. */
interface LeaseOwnership {
  readonly taskId: string;
  readonly workerId: string;
  readonly generation: number;
  /** The run execution the lease runs; 0 for a check. */
  readonly executionNumber: number;
  readonly expiresAt: string;
  /** Server-relative validity; consumers subtract the full request round trip. */
  readonly remainingMs: number;
}

/**
 * How a worker names its execution in every request after the pull. The task and the generation
 * identify the lease; the server reads everything else from its row.
 */
export type LeaseRef = Pick<LeaseOwnership, "taskId" | "generation">;

export type ExecutionLease = LeaseOwnership &
  (
    | { readonly runId: string; readonly checkId: null; readonly dueAt: null }
    | { readonly runId: null; readonly checkId: string; readonly dueAt: string }
  );

/**
 * What the requests of one prepared execution share. Each request reads it from the lease row and
 * writes it back in the same transaction, so any API process answers the next request, including
 * one started while the execution ran.
 */
export interface ExecutionState {
  /** The variables `start` delivers: declared secrets, connection tokens and the run's link key. */
  readonly secrets: Readonly<Record<string, string>>;
  /** The values redacted from the execution's output and result. */
  readonly redacted: readonly string[];
  /** The last accepted output chunk and its digest, so a retried chunk is acknowledged once. */
  readonly sequence: number;
  readonly digest: string | null;
  readonly stdout: ExecutionStream;
  readonly stderr: ExecutionStream;
  /** Stderr after its last newline: structured events are read one whole line at a time. */
  readonly line: string;
  /** What the complete stderr lines reported so far, kept however the execution ends. */
  readonly signals: ExecutionSignals;
  /**
   * A check's connection token and secret versions, written with its outcome; a run recorded its
   * own when prepared.
   */
  readonly connectionUsages: readonly StoredConnectionUsage[];
  readonly secretUsages: readonly StoredSecretUsage[];
}
export interface ExecutionSignals {
  /** `api_contact` events folded per host, unredacted until they are recorded. */
  readonly contacts: Readonly<Record<string, Omit<ApiContactObservation, "host">>>;
  /** `rate_limit_usage` counts per group. */
  readonly rateLimitUsage: Readonly<Record<string, number>>;
}
export interface ExecutionStream {
  /** Bytes accepted so far, against the per-stream output limit. */
  readonly bytes: number;
  /** Unredacted text that a redacted value may still continue into the next chunk. */
  readonly pending: string;
}
/** One transaction under the lease lock. */
export interface LeaseScope {
  readonly store: ControlPlaneStore;
  /** The lease as its row holds it now. */
  readonly lease: ExecutionLease;
  /** Null until the server prepared the execution. */
  readonly executionState: ExecutionState | null;
  /** Writes the execution's next state with this transaction. */
  save(state: ExecutionState): Promise<void>;
  /**
   * Ends the execution with this transaction: releases the lease and drops its state. `resultDigest`
   * names the accepted report, so its repeat is acknowledged; null when no report ended it.
   */
  release(resultDigest: string | null): Promise<void>;
}

/**
 * The execution a claim starts: the run's next one, spending the next attempt of the budget its
 * segment has left. Both dispatch stores number executions with it.
 */
export function nextExecution(run: Pick<StoredRun, "attemptsMade" | "executions">) {
  return {
    executionNumber: (run.executions.at(-1)?.executionNumber ?? 0) + 1,
    attempt: run.attemptsMade + 1,
  };
}

/** A running execution whose lease its worker lost. */
export interface LostExecution {
  readonly lease: ExecutionLease & { readonly runId: string };
  /** Whether the worker called `start`: it received the secrets and may have run the process. */
  readonly started: boolean;
}

/** A queued run no worker took within its queue timeout, with its project's name for the error. */
export interface ExpiredPlacement {
  readonly run: StoredRun;
  readonly projectName: string;
}

export interface DispatchStore {
  /** Serializes worker capacity and the run's queued -> running transition in PostgreSQL. */
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
  /**
   * Records that the worker began this execution and returns its prepared state: the worker is about
   * to receive secrets. A lease that expires unstarted returns its run to the queue without
   * spending an attempt, once per attempt.
   */
  start(identity: WorkerIdentity, lease: LeaseRef): Promise<ExecutionState>;
  /**
   * Holds the lease lock, and the run's or check's, while the server applies state, steps, output
   * or a result for the worker that owns the lease. It takes no worker row lock, so a worker's
   * output and renewals do not queue behind its claims.
   */
  access<T>(
    identity: WorkerIdentity,
    lease: LeaseRef,
    apply: (scope: LeaseScope) => Promise<T>,
  ): Promise<T>;
  completed(identity: WorkerIdentity, lease: LeaseRef, resultDigest: string): Promise<boolean>;
  /**
   * Ends every lease its worker lost: expired, past its deadline, revoked, or whose run stopped
   * running. For a run still running, `lose` records how its execution ended, in the transaction
   * that releases the lease; the run lifecycle owns that decision.
   */
  reclaim(lose: (lost: LostExecution, store: ControlPlaneStore) => Promise<void>): Promise<void>;
  /**
   * Hands each queued run past its placement deadline to `fail` under the run's row lock. One
   * indexed query finds them, so the per-second pass costs nothing while no run is due.
   */
  expirePlacements(
    fail: (expired: ExpiredPlacement, store: ControlPlaneStore) => Promise<void>,
  ): Promise<void>;
  /** Runs durable terminal follow-ups under only the terminal run lock. */
  drainTerminals(apply: (run: StoredRun, store: ControlPlaneStore) => Promise<void>): Promise<void>;
  /** Notification intents committed earlier; delivery never owns a worker/check/lease lock. */
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
