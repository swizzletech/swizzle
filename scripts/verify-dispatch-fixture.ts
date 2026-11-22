import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_PROJECT_ID,
  isFinishedRun,
  type PlatformRunStatus,
  type WorkerCredential,
} from "@swizzle/db";
import {
  createDashboardStore,
  createPostgresControlPlaneStore,
  createPostgresDispatchStore,
  createPostgresWorkerRegistry,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { createQueueNameForProfile } from "@swizzle/runtime";
import {
  createBullMqConnection,
  createPlatformServices,
  type ExecutionAssignment,
  type ExecutionReport,
  executeAssignment,
  localExecutionProtocol,
  readWorkerReply,
  WORKER_ROUTES,
} from "@swizzle/runtime/platform";
import { Queue } from "bullmq";
import type { PoolClient } from "pg";
import { startVerificationApi } from "./verify-api-process.js";

export async function waitFor(predicate: () => Promise<boolean>, signal?: AbortSignal) {
  while (!(await predicate())) {
    await delay(30, undefined, signal === undefined ? undefined : { signal });
  }
}

type DispatchFixtureBody = (fixture: DispatchFixture) => Promise<void>;

export async function withDispatchFixture(client: DatabaseClient, run: DispatchFixtureBody) {
  await using resources = new AsyncDisposableStack();
  const fixture = await createDispatchFixture(client, resources);
  await run(fixture);
}

export type DispatchFixture = Awaited<ReturnType<typeof createDispatchFixture>>;

async function createDispatchFixture(client: DatabaseClient, resources: AsyncDisposableStack) {
  const id = randomUUID().slice(0, 8);
  const profile = `dispatch-${id}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-dispatch-proof-"));
  resources.defer(() => rm(directory, { force: true, recursive: true }));
  const artifactsDirectory = await mkdtemp(path.join(os.tmpdir(), "swizzle-dispatch-artifacts-"));
  resources.defer(() => rm(artifactsDirectory, { force: true, recursive: true }));
  const registry = createPostgresWorkerRegistry({ client });
  const direct = createPostgresDispatchStore({ client });
  const platform = await createPlatformServices({
    artifactsDirectory,
    store: createPostgresControlPlaneStore({ client }),
    dashboardStore: createDashboardStore({ client }),
    workerRegistry: registry,
  });
  resources.defer(() => platform.close());
  resources.defer(() => registry.close());
  const queues = new Map<string, Queue>();
  const queue = (group: string) => {
    const existing = queues.get(group);
    if (existing !== undefined) return existing;
    const owned = new Queue(createQueueNameForProfile(group), {
      connection: createBullMqConnection(process.env.VALKEY_URL ?? "redis://localhost:6379"),
    });
    queues.set(group, owned);
    return owned;
  };
  resources.defer(async () => {
    const cleanup = await Promise.allSettled(
      [...queues.values()].map(async (owned) => {
        try {
          await owned.obliterate({ force: true });
        } finally {
          await owned.close();
        }
      }),
    );
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, "Dispatch queue cleanup failed.");
  });
  const credentials: WorkerCredential[] = [];
  resources.defer(async () => {
    for (const credential of credentials) await registry.revoke(credential.worker.id, null);
  });
  const trackWorker = (credential: WorkerCredential) => {
    credentials.push(credential);
    return credential;
  };
  const issue = async (name: string, profiles = [profile]) => {
    for (const group of profiles) queue(group);
    const enrollment = await registry.create({
      name: `${name}-${id}`,
      profiles,
      services: [],
      capacity: 1,
      issuedBy: null,
      environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "local" }],
    });
    const credential = await registry.enroll(enrollment.code, `${name}-${id}`);
    return trackWorker(credential);
  };
  const localToken = `swz_${randomBytes(32).toString("base64url")}`;
  let api: Awaited<ReturnType<typeof startVerificationApi>> | undefined;
  const stopApi = async () => {
    await api?.close();
    api = undefined;
  };
  resources.defer(stopApi);
  const startApi = async (environment = process.env) => {
    assert.equal(api, undefined);
    api = await startVerificationApi({
      ...environment,
      SWIZZLE_ARTIFACTS_DIR: artifactsDirectory,
      SWIZZLE_LOCAL_WORKER_TOKEN: localToken,
    });
    return api;
  };
  const request = async (
    worker: WorkerCredential,
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ) => {
    assert.ok(api !== undefined);
    const base = worker.worker.kind === "local" ? api.localUrl : api.url;
    const response = await fetch(`${base}/worker/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${worker.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
    const value: unknown = await response.json();
    return { status: response.status, value };
  };
  const ref = (lease: ExecutionAssignment["lease"]) => ({
    taskId: lease.taskId,
    generation: lease.generation,
  });
  const expireLease = async ({ lease }: ExecutionAssignment) => {
    const expired = await client.pool.query(
      "UPDATE execution_leases SET expires_at = CURRENT_TIMESTAMP WHERE task_id = $1 AND generation = $2 AND NOT released",
      [lease.taskId, lease.generation],
    );
    assert.equal(expired.rowCount, 1);
  };
  const pull = async (worker: WorkerCredential, signal?: AbortSignal) => {
    const response = await request(worker, "pull", {}, signal);
    assert.equal(response.status, 200);
    return readWorkerReply(WORKER_ROUTES.pull, response.value).assignment;
  };
  const pullRun = async (worker: WorkerCredential, runId: string, signal?: AbortSignal) => {
    const assignment = await pull(worker, signal);
    if (assignment?.lease.runId === runId) return assignment;
    const run = await platform.getPlatformRun(runId);
    const last = run.executions.at(-1);
    return assert.fail(
      `${worker.worker.name} pulled ${assignment?.lease.runId ?? "nothing"} instead of run ${runId} (${run.status}); its last execution: ${last === undefined ? "none" : `${last.status} ${last.errorCode}: ${last.errorMessage}`}`,
    );
  };
  const deploy = async (name: string, group = profile, timeout?: string, runtime = "") => {
    await writeFile(
      path.join(directory, "config.yaml"),
      `name: ${name}\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /${name}\nruntime:\n  profile: ${group}\n${timeout === undefined ? "" : `  queue_timeout: ${timeout}\n`}${runtime}`,
    );
    await writeFile(
      path.join(directory, "main.js"),
      `let raw = ''; for await (const part of process.stdin) raw += part; const input = JSON.parse(raw); if (input.holdFirst && process.env.SWIZZLE_ATTEMPT === '1') { console.error('holding first attempt'); setInterval(() => {}, 60_000); await new Promise(() => {}); } console.log(JSON.stringify({ message: input.message, db: !!process.env.DATABASE_URL, queue: !!process.env.VALKEY_URL, masterKey: !!process.env.SWIZZLE_ENCRYPTION_KEY }));`,
    );
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
  };
  const deployParent = async (name: string, child: string, resumeDelayMs?: number) => {
    await writeFile(
      path.join(directory, "config.yaml"),
      `name: ${name}\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /${name}\nruntime:\n  profile: ${profile}\n`,
    );
    await writeFile(
      path.join(directory, "main.js"),
      `import fs from 'node:fs';const steps=JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE,'utf8'));console.log(JSON.stringify(steps.child??{$swizzle:{suspend:{reason:'child',stepKey:'child',automation:'${child}',payload:{}}}}));${resumeDelayMs === undefined ? "" : `if (steps.child) await new Promise(resolve => setTimeout(resolve, ${resumeDelayMs}));`}`,
    );
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
  };
  const enqueue = async (name: string, payload: unknown) =>
    (await platform.enqueuePlatformRun({ automationName: name, environment: "local", payload }))
      .runId;
  const wait = async (runId: string, status: PlatformRunStatus) => {
    for (;;) {
      const run = await platform.getPlatformRun(runId);
      if (run.status === status) return run;
      assert.ok(
        !isFinishedRun(run.status),
        `run ${runId}: wanted ${status}, got ${run.status}, ${run.errorCode}: ${run.errorMessage}`,
      );
      await delay(30);
    }
  };
  const ok = async (
    worker: WorkerCredential,
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ) => {
    const response = await request(worker, route, body, signal);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.value)}`);
    return response.value;
  };
  const execute = async (
    worker: WorkerCredential,
    assignment: ExecutionAssignment,
    abort = new AbortController(),
    outputPublished?: () => void,
  ) => {
    let sequence = 0;
    let output = Promise.resolve();
    const { lease } = assignment;
    const report = await executeAssignment({
      assignment,
      channel: {
        source: async () =>
          readWorkerReply(WORKER_ROUTES.source, await ok(worker, "source", { lease: ref(lease) }))
            .files,
        start: async () => {
          const { secrets } = readWorkerReply(
            WORKER_ROUTES.start,
            await ok(worker, "start", { lease: ref(lease) }),
          );
          return secrets;
        },
        ready: async () => {
          await ok(worker, "ready", { lease: ref(lease) });
          if (lease.runId !== null) {
            const running = await wait(lease.runId, "running");
            assert.equal(running.executions.at(-1)?.phase, "executing");
          }
        },
        output: (stream, chunk) => {
          output = output.then(async () => {
            await ok(worker, "output", { lease: ref(lease), sequence: ++sequence, stream, chunk });
            outputPublished?.();
          });
          return output;
        },
      },
      environment: process.env,
      executor: localExecutionProtocol,
      signal: abort.signal,
    });
    await output;
    return report;
  };
  const finish = async (
    worker: WorkerCredential,
    assignment: ExecutionAssignment,
    report: ExecutionReport,
  ) => {
    assert.equal(
      (await request(worker, "complete", { lease: ref(assignment.lease), report })).status,
      200,
    );
  };
  await startApi();
  return {
    client,
    id,
    directory,
    profile,
    platform,
    registry,
    direct,
    trackWorker,
    queue,
    issue,
    startApi,
    stopApi,
    localToken,
    request,
    ref,
    expireLease,
    pull,
    pullRun,
    deploy,
    deployParent,
    enqueue,
    wait,
    ok,
    execute,
    finish,
  };
}

export async function waitForLockWaiter(holder: PoolClient, signal?: AbortSignal) {
  await waitFor(async () => {
    const result = await holder.query<{ waiting: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS waiting",
    );
    return result.rows[0]?.waiting === true;
  }, signal);
}
