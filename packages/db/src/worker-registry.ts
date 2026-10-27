import { createHash, randomBytes } from "node:crypto";
import { LOCAL_LLM_SERVICE } from "@swizzle/config";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { FULL_SCOPE } from "./access.js";
import { createPostgresApiTokenStore } from "./api-tokens.js";
import type { AuditEventOf } from "./audit.js";
import { auditEventsOf } from "./audit.js";
import { createPostgresAuditStore, recordAuditChange } from "./audit-tables.js";

import { spendBudget } from "./budgets.js";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { CodedError } from "./coded-error.js";
import {
  apiTokens,
  automations,
  deployments,
  executionLeases,
  runs,
  workerGrants,
  workers,
} from "./schema.js";
import { credentialLive, holdsCredential, selectWorkerCredentials } from "./worker-credentials.js";
import {
  explainPlacement,
  type PlacementWorker,
  type RegisteredWorker,
  runImageDiskOverBudget,
  type ServiceHealth,
  type WorkerIdentity,
  type WorkerRegistry,
  type WorkerRun,
  type WorkerStatus,
  workerReach,
  workerReaches,
} from "./workers.js";

const MINUTE = 60_000;
const ENROLLMENT_LIFETIME_MS = 10 * MINUTE;
const ENROLLMENT_REQUEST_LIMIT = 10;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Row = typeof workers.$inferSelect & {
  readonly tokenExpiresAt: Date | null;
  readonly environments: readonly import("./workers.js").WorkerEnvironment[];
};
type CredentialRow = Row & { readonly tokenId: string | null };
type Transaction = Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0];
const forbidden = () =>
  new CodedError(
    "WORKER_FORBIDDEN",
    "Worker credential is invalid, expired, consumed, or revoked. Ask an instance owner or admin to enroll a new worker.",
  );
const budgetExceeded = () =>
  new CodedError(
    "WORKER_BUDGET_EXCEEDED",
    "Worker enrollment budget exhausted. Retry after 60 seconds.",
  );

/** All mutations lock the identity row, so enrollment, renewal and revocation cannot race. */
export function createPostgresWorkerRegistry(
  options: { readonly client?: DatabaseClient } = {},
): WorkerRegistry {
  const client = options.client ?? createDatabaseClient();
  const { db } = client;
  const tokens = (tx: DatabaseClient["db"]) =>
    createPostgresApiTokenStore({ client: { ...client, db: tx } });
  const event = (
    tx: Transaction,
    row: typeof workers.$inferSelect,
    action: AuditEventOf<"worker">["change"]["action"],
    issuedBy: string | null = null,
  ) =>
    recordAuditChange(tx, {
      change: { kind: "worker", action, issuedBy, workerId: row.id },
      occurredAt: new Date().toISOString(),
      ...(action !== "created" && action !== "revoked"
        ? { actor: { kind: "worker" as const, workerId: row.id, label: row.name } }
        : {}),
    });
  const locked = async (tx: Transaction, identity: WorkerIdentity) => {
    const [row] = await selectWorkerCredentials(tx)
      .where(eq(workers.id, identity.id))
      .for("update", { of: workers });
    if (!holdsCredential(row, identity)) throw forbidden();
    return row;
  };
  const rotate = async (tx: Transaction, row: CredentialRow, plaintext?: string) => {
    const store = tokens(tx);
    const holder = { kind: "worker", workerId: row.id } as const;
    const minted =
      row.tokenId === null
        ? await store.createToken({ holder, name: "worker", scope: FULL_SCOPE, issuedBy: null })
        : await store.rotateToken(holder, row.tokenId, null, plaintext);
    if (minted === null) throw forbidden();
    const [updated] = await tx
      .update(workers)
      .set({ credentialGeneration: row.credentialGeneration + 1 })
      .where(eq(workers.id, row.id))
      .returning();
    if (updated === undefined) throw forbidden();
    return {
      token: minted.token,
      worker: view({
        ...updated,
        environments: row.environments,
        tokenExpiresAt: new Date(minted.expiresAt),
      }),
    };
  };

  return {
    async create(input) {
      const code = `swze_${randomBytes(32).toString("base64url")}`;
      return await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(workers)
          .values({
            name: input.name,
            capacity: input.capacity ?? 1,
            profiles: [...new Set(input.profiles)],
            services: [...input.services],
            enrollmentHash: hash(code),
            enrollmentExpiresAt: new Date(Date.now() + ENROLLMENT_LIFETIME_MS),
          })
          .returning();
        if (row === undefined) throw new Error("Failed to create worker.");
        if (input.environments.length > 0)
          await tx
            .insert(workerGrants)
            .values(input.environments.map((grant) => ({ ...grant, workerId: row.id })))
            .onConflictDoNothing();
        await event(tx, row, "created", input.issuedBy);
        return {
          code,
          expiresAt: row.enrollmentExpiresAt.toISOString(),
          worker: view({ ...row, environments: input.environments, tokenExpiresAt: null }),
        };
      });
    },
    async enroll(code, clientKey) {
      // This transaction commits even when a code is wrong. A wrong code must consume budget.
      const budget = await spendBudget(
        db,
        `worker-enrollment:${clientKey}`,
        ENROLLMENT_REQUEST_LIMIT,
        MINUTE,
      );
      const allowed = budget.allowed;
      if (!allowed) throw budgetExceeded();
      return await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(workers)
          .where(eq(workers.enrollmentHash, hash(code)))
          .for("update");
        if (
          row === undefined ||
          row.revokedAt !== null ||
          row.credentialGeneration !== 0 ||
          row.enrollmentExpiresAt <= new Date()
        )
          throw forbidden();
        await tx.update(workers).set({ enrollmentHash: null }).where(eq(workers.id, row.id));
        const result = await rotate(tx, {
          ...row,
          environments: await tx
            .select({ projectId: workerGrants.projectId, environment: workerGrants.environment })
            .from(workerGrants)
            .where(eq(workerGrants.workerId, row.id)),
          tokenId: null,
          tokenExpiresAt: null,
        });
        await event(tx, row, "enrolled");
        return result;
      });
    },
    async list() {
      const now = new Date();
      const [rows, leases] = await Promise.all([
        selectWorkerCredentials(db).orderBy(desc(workers.createdAt)),
        db
          .select({
            workerId: executionLeases.workerId,
            runId: runs.id,
            automationName: automations.name,
            automationSlug: automations.slug,
            projectId: runs.projectId,
            environment: deployments.environment,
            startedAt: runs.startedAt,
          })
          .from(executionLeases)
          .leftJoin(runs, eq(runs.id, executionLeases.runId))
          .leftJoin(automations, eq(automations.id, runs.automationId))
          .leftJoin(deployments, eq(deployments.id, runs.deploymentId))
          .where(and(eq(executionLeases.released, false), gt(executionLeases.expiresAt, now))),
      ]);
      return rows.map((row): WorkerStatus => {
        const held = leases.filter((lease) => lease.workerId === row.id);
        // API checks hold slots too; only runs carry an automation to name.
        const currentRuns = held.flatMap(({ workerId: _, runId, ...run }): WorkerRun[] =>
          runId === null ||
          run.automationName === null ||
          run.automationSlug === null ||
          run.projectId === null ||
          run.environment === null
            ? []
            : [
                {
                  runId,
                  automationName: run.automationName,
                  automationSlug: run.automationSlug,
                  projectId: run.projectId,
                  environment: run.environment,
                  startedAt: run.startedAt?.toISOString() ?? null,
                },
              ],
        );
        const worker = placementWorker(row, held.length);
        return { ...worker, currentRuns, runImageDiskOverBudget: runImageDiskOverBudget(worker) };
      });
    },
    async placement(run) {
      const [row] = await db
        .select({ deadline: runs.placementDeadlineAt })
        .from(runs)
        .where(eq(runs.id, run.runId));
      if (row === undefined) throw new Error(`Run not found: ${run.runId}`);
      return explainPlacement({ ...run, deadline: row.deadline }, await this.list());
    },
    async revoke(id, issuedBy) {
      return await db.transaction(async (tx) => {
        const [row] = await selectWorkerCredentials(tx)
          .where(eq(workers.id, id))
          .for("update", { of: workers });
        if (row === undefined) throw new CodedError("WORKER_NOT_FOUND", "Worker not found.");
        if (row.revokedAt !== null) return view(row);
        if (row.tokenId !== null)
          await tokens(tx).revokeToken({ kind: "worker", workerId: id }, row.tokenId);
        const [updated] = await tx
          .update(workers)
          .set({ revokedAt: new Date(), enrollmentHash: null })
          .where(eq(workers.id, id))
          .returning();
        if (updated === undefined) throw forbidden();
        await event(tx, row, "revoked", issuedBy);
        return view({
          ...updated,
          environments: row.environments,
          tokenExpiresAt: row.tokenExpiresAt,
        });
      });
    },
    async authenticate(workerId, tokenId) {
      const [row] = await selectWorkerCredentials(db).where(
        and(eq(workers.id, workerId), eq(apiTokens.id, tokenId)),
      );
      if (!credentialLive(row)) throw forbidden();
      return view(row);
    },
    async session(identity, target) {
      const result = await db.transaction(async (tx) => {
        const row = await locked(tx, identity);
        if (!row.profiles.includes(target.profile) || !workerReaches(workerReach(row), target)) {
          await event(tx, row, "scope-denied");
          return null;
        }
        return view(row);
      });
      if (result === null)
        throw new CodedError(
          "WORKER_SCOPE_DENIED",
          "The worker is not granted this profile and project/environment. An owner or admin controls worker grants.",
        );
      return result;
    },
    async heartbeat(identity, report) {
      return await db.transaction(async (tx) => {
        const row = await locked(tx, identity);
        const now = new Date();
        const [updated] = await tx
          .update(workers)
          .set({
            lastSeenAt: now,
            ...(report === undefined
              ? {}
              : {
                  capabilities: report.capabilities,
                  serviceHealth: report.services,
                  serviceHealthAt: now,
                  runImageDisk: report.runImageDisk,
                }),
          })
          .where(eq(workers.id, row.id))
          .returning();
        if (updated === undefined) throw forbidden();
        return placementWorker(
          { ...updated, environments: row.environments, tokenExpiresAt: row.tokenExpiresAt },
          await heldSlots(tx, row.id),
        );
      });
    },
    async drain(identity, draining) {
      await db.transaction(async (tx) => {
        await locked(tx, identity);
        await tx.update(workers).set({ draining }).where(eq(workers.id, identity.id));
      });
    },
    async renew(identity, nextToken) {
      return await db.transaction(async (tx) => {
        const row = await locked(tx, identity);
        const result = await rotate(tx, row, nextToken);
        await event(tx, row, "renewed");
        return result;
      });
    },
    async audit(id) {
      return auditEventsOf(
        "worker",
        await createPostgresAuditStore({ client }).list({
          environments: null,
          projectIds: null,
          workerId: id,
          kind: "worker",
          limit: null,
        }),
      );
    },
    async close() {
      if (options.client === undefined) await client.close();
    },
  };
}

/** The slots a worker's unexpired, unreleased leases hold. */
export async function heldSlots(tx: Transaction, workerId: string): Promise<number> {
  const [held] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(executionLeases)
    .where(
      and(
        eq(executionLeases.workerId, workerId),
        eq(executionLeases.released, false),
        gt(executionLeases.expiresAt, new Date()),
      ),
    );
  return held?.count ?? 0;
}

/**
 * A worker row as placement reads it, for the registry's list and for claims under the row lock:
 * the local LLM's health counts only from a report within the last minute.
 */
export function placementWorker(
  row: Row,
  slotsInUse: number,
): RegisteredWorker & PlacementWorker & { readonly localLlm: ServiceHealth } {
  const fresh = row.serviceHealthAt !== null && Date.now() - row.serviceHealthAt.getTime() < MINUTE;
  return {
    ...view(row),
    slotsInUse,
    localLlm: fresh ? (row.serviceHealth[LOCAL_LLM_SERVICE] ?? null) : null,
  };
}

function view(row: Row): RegisteredWorker {
  return {
    kind: row.local ? "local" : "remote",
    capacity: row.capacity,
    draining: row.draining,
    id: row.id,
    credentialGeneration: row.credentialGeneration,
    name: row.name,
    profiles: row.profiles,
    services: row.services,
    environments: workerReach(row),
    state: workerState(row),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    runImageDisk: row.runImageDisk,
    capabilities: row.capabilities,
  };
}

function workerState(row: Row): RegisteredWorker["state"] {
  if (row.revokedAt !== null) return "revoked";
  if (row.credentialGeneration === 0) return "pending";
  if (
    credentialLive(row) &&
    row.lastSeenAt !== null &&
    Date.now() - row.lastSeenAt.getTime() < MINUTE
  )
    return "online";
  return "offline";
}
