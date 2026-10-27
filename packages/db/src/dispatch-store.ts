import { parseQueueTimeoutToMs } from "@swizzle/config";
import { and, eq, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { createPostgresControlPlaneStore } from "./control-plane.js";
import { getNotificationDeliveryById } from "./control-plane-read-models.js";
import {
  type DispatchStore,
  type ExecutionLease,
  ExecutionLeaseError,
  type ExecutionState,
  type LeaseRef,
  type LeaseScope,
  nextExecution,
} from "./dispatch.js";
import {
  apiTokens,
  automationChecks,
  executionLeases,
  notificationDeliveries,
  projects,
  runs,
  workers,
} from "./schema.js";
import { decryptSecretValue, encryptSecretValue, SECRET_ENCRYPTION_ALGORITHM } from "./secrets.js";
import { credentialLive, holdsCredential, selectWorkerCredentials } from "./worker-credentials.js";
import { heldSlots, placementWorker } from "./worker-registry.js";
import { type PlacementTarget, type WorkerIdentity, workerFit } from "./workers.js";

type Transaction = Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0];
// Covers the existing ten-minute image assembly and bounded staging/cleanup operations.
const EXECUTION_PREPARATION_BUDGET_MS = 15 * 60_000;
type LeaseRow = typeof executionLeases.$inferSelect;
const seal = (state: ExecutionState) => encryptSecretValue(JSON.stringify(state)).ciphertext;
// The lease row holds only what this module sealed.
const unseal = (ciphertext: string): ExecutionState =>
  JSON.parse(decryptSecretValue({ algorithm: SECRET_ENCRYPTION_ALGORITHM, ciphertext }));
const view = (row: Omit<LeaseRow, "resultDigest" | "executionState">): ExecutionLease => {
  const owner = {
    taskId: row.taskId,
    workerId: row.workerId,
    generation: row.generation,
    executionNumber: row.executionNumber,
    expiresAt: row.expiresAt.toISOString(),
    remainingMs: Math.max(
      0,
      Math.min(row.expiresAt.getTime(), row.deadlineAt.getTime()) - Date.now(),
    ),
  };
  if (row.runId !== null) return { ...owner, runId: row.runId, checkId: null, dueAt: null };
  if (row.checkId === null || row.dueAt === null) throw new Error("Execution lease has no target.");
  return { ...owner, runId: null, checkId: row.checkId, dueAt: row.dueAt.toISOString() };
};

async function admitWithinDeadline(admit: () => Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      admit(),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Locks follow worker -> run -> lease; a lease request skips the worker, never reorders. */
export function createPostgresDispatchStore(
  options: { readonly client?: DatabaseClient; readonly leaseMs?: number } = {},
): DispatchStore {
  const client = options.client ?? createDatabaseClient();
  const leaseMs = options.leaseMs ?? 90_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000)
    throw new Error("Worker execution lease must be at least 1000 milliseconds.");
  const scoped = (tx: Transaction) =>
    createPostgresControlPlaneStore({ client: { ...client, db: tx } });
  /**
   * Locks a lease's run or check, then the lease row, the order claims take, and reads its worker
   * without a lock: claims hold the worker row while they count slots, so output and renewals
   * would queue behind them. A revocation that commits after this read ends the lease on the next
   * reclaim pass.
   */
  const lock = async (tx: Transaction, ref: LeaseRef) => {
    const [target] = await tx
      .select({ runId: executionLeases.runId, checkId: executionLeases.checkId })
      .from(executionLeases)
      .where(eq(executionLeases.taskId, ref.taskId));
    const [run] =
      target?.runId == null
        ? []
        : await tx.select().from(runs).where(eq(runs.id, target.runId)).for("update");
    if (target?.checkId != null)
      await tx
        .select()
        .from(automationChecks)
        .where(eq(automationChecks.id, target.checkId))
        .for("update");
    const [row] = await tx
      .select()
      .from(executionLeases)
      .where(eq(executionLeases.taskId, ref.taskId))
      .for("update");
    const [worker] =
      row === undefined
        ? []
        : await selectWorkerCredentials(tx).where(eq(workers.id, row.workerId));
    return { worker, run, row };
  };
  /**
   * Locks the claiming worker and returns whether it takes work of `target` now, by `workerFit`.
   * The caller asks again after admission, which may have waited, before it spends an attempt.
   */
  const claimant = async (tx: Transaction, identity: WorkerIdentity) => {
    const [worker] = await selectWorkerCredentials(tx)
      .where(eq(workers.id, identity.id))
      .for("update", { of: workers });
    if (!holdsCredential(worker, identity)) return null;
    const slots = await heldSlots(tx, identity.id);
    return {
      name: worker.name,
      fits: (target: PlacementTarget) =>
        workerFit(placementWorker(worker, slots), target) === "ready",
    };
  };
  const scope = (tx: Transaction, row: LeaseRow): LeaseScope => ({
    store: scoped(tx),
    lease: view(row),
    executionState: row.executionState === null ? null : unseal(row.executionState),
    async save(state) {
      await tx
        .update(executionLeases)
        .set({ executionState: seal(state) })
        .where(eq(executionLeases.taskId, row.taskId));
    },
    async release(resultDigest) {
      await tx
        .update(executionLeases)
        .set({ released: true, resultDigest, executionState: null })
        .where(eq(executionLeases.taskId, row.taskId));
    },
  });
  /** The lease row `identity` may act on now, or ExecutionLeaseError. */
  const owned = async (tx: Transaction, identity: WorkerIdentity, ref: LeaseRef) => {
    const { worker, run, row } = await lock(tx, ref);
    const now = new Date();
    if (
      row === undefined ||
      row.released ||
      row.generation !== ref.generation ||
      row.workerId !== identity.id ||
      !holdsCredential(worker, identity) ||
      (row.runId !== null && run?.status !== "running") ||
      row.expiresAt <= now ||
      row.deadlineAt <= now
    )
      throw new ExecutionLeaseError();
    return row;
  };
  return {
    async claim(identity: WorkerIdentity, runId, admit) {
      return await client.db.transaction(async (tx) => {
        const worker = await claimant(tx, identity);
        if (worker === null) return null;
        const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
        if (row === undefined || row.status !== "queued") return null;
        const store = scoped(tx);
        const run = await store.getRun(runId);
        if (run === null) return null;
        const target = {
          projectId: run.projectId,
          environment: run.environment,
          profile: run.config.runtime.profile,
          services: run.config.runtime.permissions.services,
        };
        if (!worker.fits(target)) return null;
        const deadline = row.placementDeadlineAt;
        if (new Date() >= deadline) return null;
        const [previous] = await tx
          .select()
          .from(executionLeases)
          .where(eq(executionLeases.taskId, runId))
          .for("update");
        if (previous !== undefined && !previous.released) return null;
        if (admit !== undefined && !(await admitWithinDeadline(admit))) return null;
        const now = new Date();
        if (!worker.fits(target) || now >= deadline) return null;
        const { executionNumber, attempt } = nextExecution(run);
        const deadlineAt = new Date(
          now.getTime() +
            parseQueueTimeoutToMs(run.config.runtime.timeout) +
            EXECUTION_PREPARATION_BUDGET_MS,
        );
        const lease = {
          deadlineAt,
          taskId: runId,
          runId,
          checkId: null,
          dueAt: null,
          workerId: identity.id,
          generation: (previous?.generation ?? 0) + 1,
          executionNumber,
          expiresAt: new Date(now.getTime() + leaseMs),
          released: false,
          startedAt: null,
          executionState: null,
        };
        await tx
          .insert(executionLeases)
          .values(lease)
          .onConflictDoUpdate({ target: executionLeases.taskId, set: lease });
        await store.updateRunState({
          runId,
          status: "running",
          attemptsMade: attempt,
          startedAt: run.startedAt ?? now.toISOString(),
        });
        await store.createRunExecution({
          runId,
          executionNumber,
          attempt,
          queueJobId: run.queueJobId,
          startedAt: now.toISOString(),
          status: "running",
          workerName: worker.name,
          metadata: { workerId: identity.id, generation: lease.generation },
        });
        return view(lease);
      });
    },
    async claimCheck(identity, checkId, dueAt, admit) {
      return await client.db.transaction(async (tx) => {
        const worker = await claimant(tx, identity);
        if (worker === null) return null;
        const [row] = await tx
          .select()
          .from(automationChecks)
          .where(eq(automationChecks.id, checkId))
          .for("update");
        if (row?.nextCheckAt.toISOString() !== dueAt) return null;
        const store = scoped(tx);
        const check = await store.getAutomationCheck(checkId);
        const deployment =
          check === null ? null : await store.getDeploymentById(check.deploymentId);
        if (deployment === null) return null;
        const target = {
          projectId: deployment.projectId,
          environment: deployment.environment,
          profile: deployment.config.runtime.profile,
          services: deployment.config.runtime.permissions.services,
        };
        if (!worker.fits(target)) return null;
        const taskId = `check-${checkId}-${Date.parse(dueAt)}`;
        const [previous] = await tx
          .select()
          .from(executionLeases)
          .where(eq(executionLeases.taskId, taskId))
          .for("update");
        if (previous !== undefined && !previous.released && previous.expiresAt > new Date())
          return null;
        if (admit !== undefined && !(await admitWithinDeadline(admit))) return null;
        if (!worker.fits(target)) return null;
        const now = new Date();
        const deadlineAt = new Date(
          now.getTime() +
            parseQueueTimeoutToMs(deployment.config.runtime.timeout) +
            EXECUTION_PREPARATION_BUDGET_MS,
        );
        const lease = {
          deadlineAt,
          taskId,
          runId: null,
          checkId,
          dueAt: new Date(dueAt),
          workerId: identity.id,
          generation: (previous?.generation ?? 0) + 1,
          executionNumber: 0,
          expiresAt: new Date(now.getTime() + leaseMs),
          released: false,
          startedAt: null,
          executionState: null,
        };
        await tx
          .insert(executionLeases)
          .values(lease)
          .onConflictDoUpdate({ target: executionLeases.taskId, set: lease });
        return view(lease);
      });
    },
    async renew(identity, ref) {
      return await client.db.transaction(async (tx) => {
        const row = await owned(tx, identity, ref);
        const expiresAt = new Date(Math.min(Date.now() + leaseMs, row.deadlineAt.getTime()));
        await tx
          .update(executionLeases)
          .set({ expiresAt })
          .where(eq(executionLeases.taskId, row.taskId));
        if (row.runId !== null)
          await scoped(tx).updateRunExecutionHeartbeat({
            runId: row.runId,
            executionNumber: row.executionNumber,
            heartbeatAt: new Date().toISOString(),
          });
        return view({ ...row, expiresAt });
      });
    },
    async start(identity, ref) {
      return await client.db.transaction(async (tx) => {
        const row = await owned(tx, identity, ref);
        if (row.executionState === null) throw new ExecutionLeaseError();
        if (row.startedAt === null)
          await tx
            .update(executionLeases)
            .set({ startedAt: new Date() })
            .where(eq(executionLeases.taskId, row.taskId));
        return unseal(row.executionState);
      });
    },
    async access(identity, ref, apply) {
      return await client.db.transaction(
        async (tx) => await apply(scope(tx, await owned(tx, identity, ref))),
      );
    },
    async completed(identity, ref, resultDigest) {
      return await client.db.transaction(async (tx) => {
        const { worker, row } = await lock(tx, ref);
        return (
          holdsCredential(worker, identity) &&
          row !== undefined &&
          row.workerId === identity.id &&
          row.generation === ref.generation &&
          row.released &&
          row.resultDigest === resultDigest
        );
      });
    },
    async reclaim(lose) {
      const now = new Date();
      // Narrows the pass to leases that may be lost; the locked check below decides.
      const candidates = await client.db
        .select({ taskId: executionLeases.taskId, generation: executionLeases.generation })
        .from(executionLeases)
        .leftJoin(runs, eq(runs.id, executionLeases.runId))
        .leftJoin(workers, eq(workers.id, executionLeases.workerId))
        .leftJoin(apiTokens, and(eq(apiTokens.workerId, workers.id), isNull(apiTokens.revokedAt)))
        .where(
          and(
            eq(executionLeases.released, false),
            or(
              lte(executionLeases.expiresAt, now),
              lte(executionLeases.deadlineAt, now),
              // Not `credentialLive`: no worker, a revoked one, or no current credential in time.
              isNull(workers.id),
              isNotNull(workers.revokedAt),
              isNull(apiTokens.id),
              lte(apiTokens.expiresAt, now),
              and(isNotNull(executionLeases.runId), ne(runs.status, "running")),
            ),
          ),
        );
      for (const candidate of candidates) {
        await client.db.transaction(async (tx) => {
          const { worker, run, row } = await lock(tx, candidate);
          if (row === undefined || row.generation !== candidate.generation || row.released) return;
          const now = new Date();
          const running = row.runId !== null && run?.status === "running";
          if (
            row.expiresAt > now &&
            row.deadlineAt > now &&
            credentialLive(worker) &&
            (row.runId === null || running)
          )
            return;
          const lease = view(row);
          if (lease.runId !== null && running)
            await lose({ lease, started: row.startedAt !== null }, scoped(tx));
          await tx
            .update(executionLeases)
            .set({ released: true, executionState: null })
            .where(eq(executionLeases.taskId, row.taskId));
        });
      }
    },
    async expirePlacements(fail) {
      const due = await client.db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.status, "queued"), lte(runs.placementDeadlineAt, new Date())));
      for (const candidate of due) {
        await client.db.transaction(async (tx) => {
          const [row] = await tx.select().from(runs).where(eq(runs.id, candidate.id)).for("update");
          if (row?.status !== "queued" || row.placementDeadlineAt > new Date()) return;
          const store = scoped(tx);
          const run = await store.getRun(row.id);
          if (run === null) return;
          const [project] = await tx
            .select({ name: projects.name })
            .from(projects)
            .where(eq(projects.id, run.projectId));
          await fail({ run, projectName: project?.name ?? run.projectId }, store);
        });
      }
    },
    async drainTerminals(apply) {
      const candidates = await client.db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.terminalPending, true))
        .limit(100);
      for (const candidate of candidates)
        await client.db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(runs)
            .where(and(eq(runs.id, candidate.id), eq(runs.terminalPending, true)))
            .for("update", { skipLocked: true });
          if (row === undefined) return;
          const store = scoped(tx);
          const run = await store.getRun(row.id);
          if (run !== null) await apply(run, store);
          await tx.update(runs).set({ terminalPending: false }).where(eq(runs.id, row.id));
        });
    },
    async drainNotifications(apply) {
      const candidates = await client.db
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.status, "pending"))
        .limit(100);
      for (const candidate of candidates)
        await client.db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(notificationDeliveries)
            .where(
              and(
                eq(notificationDeliveries.id, candidate.id),
                eq(notificationDeliveries.status, "pending"),
              ),
            )
            .for("update", { skipLocked: true });
          if (row === undefined) return;
          const delivery = await getNotificationDeliveryById({ ...client, db: tx }, row.id);
          if (delivery !== null) await apply(delivery, scoped(tx));
        });
    },
    async close() {
      if (options.client === undefined) await client.close();
    },
  };
}
