import { randomUUID } from "node:crypto";
import { WORKER_SERVICES } from "@swizzle/config";
import type {
  ControlPlaneStore,
  ExecutionLease,
  StoredAutomationCheck,
  WorkerIdentity,
} from "@swizzle/db";
import { ExecutionLeaseError, FULL_SCOPE } from "@swizzle/db";
import {
  createPostgresApiTokenStore,
  createPostgresDispatchStore,
  createPostgresWorkerRegistry,
} from "@swizzle/db/postgres";
import { localExecutionProtocol } from "../packages/runtime/src/execution-protocol.js";
import {
  createExecutionService,
  type ExecutionService,
} from "../packages/runtime/src/execution-service.js";
import {
  type ExecutionChannel,
  executeAssignment,
} from "../packages/runtime/src/execution-wire.js";
import type { RunLogEvent } from "../packages/runtime/src/log-stream.js";
import { deliverPendingNotification } from "../packages/runtime/src/notifications.js";
import {
  processRunTerminalEffects,
  reconcileQueuedRunsWithStore,
} from "../packages/runtime/src/run-lifecycle.js";
import type { RunQueueProducer } from "../packages/runtime/src/run-queue.js";
import { collectWorkerCapabilities } from "../packages/runtime/src/runtime-requirements.js";
import type { ExecutionAssignment } from "../packages/runtime/src/worker-wire.js";
import { testDatabase } from "./postgres.js";

const RENEWAL_MS = 2_000;

export interface TestExecution {
  /** Runs one execution of a queued run; false when the run could not be claimed. */
  run(
    runId: string,
    options: {
      readonly admit?: () => Promise<boolean>;
      readonly environment: NodeJS.ProcessEnv;
      readonly publish?: (event: RunLogEvent) => Promise<void>;
    },
  ): Promise<boolean>;
  /** Runs a due check; null when it is no longer due at `dueAt`. */
  check(
    checkId: string,
    dueAt: string,
    options: { readonly environment: NodeJS.ProcessEnv },
  ): Promise<StoredAutomationCheck | null>;
}

export async function createTestExecution(input: {
  readonly queue: RunQueueProducer;
  readonly store: ControlPlaneStore;
  readonly profiles: readonly string[];
  readonly client?: import("@swizzle/db/postgres").DatabaseClient;
}): Promise<TestExecution> {
  const { queue, store } = input;
  const client = input.client ?? testDatabase();
  const id = randomUUID();
  await client.pool.query(
    `INSERT INTO workers (id, name, local, profiles, services, capacity, credential_generation, enrollment_expires_at) VALUES ($1, 'This machine', true, $3, $2, 16, 1, now())`,
    [id, WORKER_SERVICES, input.profiles],
  );
  await createPostgresApiTokenStore({ client }).createToken({
    holder: { kind: "worker", workerId: id },
    name: "worker",
    scope: FULL_SCOPE,
    issuedBy: null,
    expiresAt: "9999-12-31T00:00:00Z",
  });
  const WORKER: WorkerIdentity = { id, credentialGeneration: 1 };
  const registry = createPostgresWorkerRegistry({ client });
  await client.pool.query("UPDATE workers SET name = 'This machine' WHERE id = $1", [id]);
  await registry.heartbeat(WORKER, {
    capabilities: await collectWorkerCapabilities([]),
    services: Object.fromEntries(WORKER_SERVICES.map((service) => [service, "healthy"])),
    runImageDisk: null,
  });
  const dispatch = createPostgresDispatchStore({ client });
  const execute = async (
    lease: ExecutionLease,
    options: {
      readonly environment: NodeJS.ProcessEnv;
      readonly publish?: (event: RunLogEvent) => Promise<void>;
    },
  ) => {
    const executions = createExecutionService({ dispatch, store, ...options });
    const assignment = await executions.prepare(WORKER, lease);
    if (assignment !== null)
      await executeTestAssignment(WORKER, executions, assignment, options.environment, () =>
        dispatch.renew(WORKER, assignment.lease),
      );
    await dispatch.drainTerminals((run, store) => processRunTerminalEffects({ run, store }));
    await dispatch.drainNotifications(async (delivery, store) => {
      await deliverPendingNotification(delivery, store);
    });
    // A failed attempt with retries left is queued again, as the API's dispatch loop does.
    await reconcileQueuedRunsWithStore(store, queue, {});
  };
  return {
    async run(runId, options) {
      await registry.heartbeat(WORKER);
      const lease = await dispatch.claim(WORKER, runId, options.admit);
      if (lease === null) return false;
      await execute(lease, options);
      return true;
    },
    async check(checkId, dueAt, options) {
      await registry.heartbeat(WORKER);
      const lease = await dispatch.claimCheck(WORKER, checkId, dueAt);
      if (lease === null) return null;
      await execute(lease, options);
      return await store.getAutomationCheck(checkId);
    },
  };
}

/** The worker's side of an assignment, as the worker service runs it, over direct calls. */
export async function executeTestAssignment(
  WORKER: WorkerIdentity,
  executions: ExecutionService,
  assignment: ExecutionAssignment,
  environment: NodeJS.ProcessEnv,
  renew: () => Promise<unknown>,
): Promise<void> {
  const { lease } = assignment;
  const abort = new AbortController();
  // A renewal is the worker's news of a cancel: the lease ends with the run.
  let unexpected: { readonly error: unknown } | undefined;
  const stopOnFailure = (error: unknown) => {
    if (!(error instanceof ExecutionLeaseError)) unexpected ??= { error };
    abort.abort(error);
  };
  let renewing = Promise.resolve();
  const renewal = setInterval(() => {
    renewing = renewing
      .then(async () => {
        if (!abort.signal.aborted) await renew();
      })
      .catch(stopOnFailure);
  }, RENEWAL_MS);
  let sequence = 0;
  let output = Promise.resolve();
  const channel: ExecutionChannel = {
    source: () => executions.source(WORKER, lease),
    start: () => executions.start(WORKER, lease),
    ready: () => executions.ready(WORKER, lease),
    output: (stream, chunk) => {
      const index = ++sequence;
      output = output.then(() => executions.output(WORKER, lease, index, stream, chunk));
      // A refused chunk ended the execution on the server: stop the process, as a worker does.
      void output.catch(stopOnFailure);
      return output;
    },
  };
  try {
    const report = await executeAssignment({
      assignment,
      channel,
      environment,
      executor: localExecutionProtocol,
      signal: abort.signal,
    });
    await output;
    await executions.complete(WORKER, lease, report);
  } catch (error) {
    stopOnFailure(error);
  } finally {
    clearInterval(renewal);
    await renewing;
    await output.catch(stopOnFailure);
  }
  if (unexpected !== undefined) throw unexpected.error;
}
