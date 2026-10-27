import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LOCAL_LLM_SERVICE } from "@swizzle/config";
import { DEFAULT_PROJECT_ID, type WorkerCredential } from "@swizzle/db";
import {
  createDashboardStore,
  createPostgresAccessStore,
  createPostgresApiTokenStore,
  createPostgresControlPlaneStore,
  createPostgresDispatchStore,
  createPostgresWorkerRegistry,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { collectWorkerCapabilities, createQueueNameForProfile } from "@swizzle/runtime";
import {
  createBullMqConnection,
  createPlatformServices,
  type ExecutionAssignment,
  type ExecutionReport,
  executeAssignment,
  localExecutionProtocol,
  readWorkerReply,
  startPlatformWorkerService,
  WORKER_ROUTES,
} from "@swizzle/runtime/platform";
import { Queue } from "bullmq";
import { withVerificationDatabase } from "./verification-database.js";
import { startVerificationApi } from "./verify-api-process.js";
import { verifyRunImages } from "./verify-run-images.js";

/** A port the OS just handed out, so a restarted API listens where its worker already points. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("No free port.");
  return address.port;
}

/** The real HTTP worker protocol, real subprocesses, PostgreSQL and BullMQ. No test endpoints. */
async function main(client: DatabaseClient) {
  process.env.SWIZZLE_ENCRYPTION_KEY ??= "12345678901234567890123456789012";
  const id = randomUUID().slice(0, 8);
  const profile = `dispatch-${id}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-dispatch-proof-"));
  const registry = createPostgresWorkerRegistry({ client });
  const platform = await createPlatformServices({
    store: createPostgresControlPlaneStore({ client }),
    dashboardStore: createDashboardStore({ client }),
    workerRegistry: registry,
  });
  const profilesOwned = new Set<string>();
  const credentials: WorkerCredential[] = [];
  const issue = async (name: string, profiles = [profile]) => {
    for (const profile of profiles) profilesOwned.add(profile);
    const enrollment = await registry.create({
      name: `${name}-${id}`,
      profiles,
      services: [],
      capacity: 1,
      issuedBy: null,
      environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "local" }],
    });
    const credential = await registry.enroll(enrollment.code, `${name}-${id}`);
    credentials.push(credential);
    return credential;
  };
  // The stack's own worker: the API provisions it and serves it on the private listener only.
  const localToken = `swz_${randomBytes(32).toString("base64url")}`;
  let api = await startVerificationApi({
    ...process.env,
    SWIZZLE_WORKER_LEASE_MS: "3000",
    SWIZZLE_LOCAL_WORKER_TOKEN: localToken,
  });
  const request = async (
    worker: WorkerCredential,
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ) => {
    const base = worker.worker.kind === "local" ? api.localUrl : api.url;
    const response = await fetch(`${base}/worker/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${worker.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    const value: unknown = await response.json();
    return { status: response.status, value };
  };
  // How every request after the pull names its attempt.
  const ref = (lease: ExecutionAssignment["lease"]) => ({
    taskId: lease.taskId,
    generation: lease.generation,
  });
  const pull = async (worker: WorkerCredential, signal?: AbortSignal) => {
    const response = await request(worker, "pull", {}, signal);
    assert.equal(response.status, 200);
    return readWorkerReply(WORKER_ROUTES.pull, response.value).assignment;
  };
  /**
   * Pulls the assignment of `runId`. When another or none comes, it fails with the run's last
   * execution error, such as an API that could not write its temporary copy of the source.
   */
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
      `let raw = ''; for await (const part of process.stdin) raw += part; const input = JSON.parse(raw); await new Promise(resolve => setTimeout(resolve, input.delayMs ?? 0)); console.log(JSON.stringify({ message: input.message, db: !!process.env.DATABASE_URL, queue: !!process.env.VALKEY_URL, masterKey: !!process.env.SWIZZLE_ENCRYPTION_KEY }));`,
    );
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
  };
  /** Deploys an automation whose first attempt invokes `child` and whose resume returns its envelope. */
  const deployParent = async (name: string, child: string) => {
    await writeFile(
      path.join(directory, "config.yaml"),
      `name: ${name}\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /${name}\nruntime:\n  profile: ${profile}\n`,
    );
    await writeFile(
      path.join(directory, "main.js"),
      `import fs from 'node:fs';const steps=JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE,'utf8'));console.log(JSON.stringify(steps.child??{$swizzle:{suspend:{reason:'child',stepKey:'child',automation:'${child}',payload:{}}}}));`,
    );
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
  };
  const enqueue = async (name: string, payload: unknown) =>
    (await platform.enqueuePlatformRun({ automationName: name, environment: "local", payload }))
      .runId;
  const wait = async (runId: string, status: string) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const run = await platform.getPlatformRun(runId);
      if (run.status === status) return run;
      assert.ok(
        Date.now() < deadline,
        `run ${runId}: wanted ${status}, got ${run.status}, ${run.errorCode}: ${run.errorMessage}`,
      );
      await delay(30);
    }
  };
  const capabilities = await collectWorkerCapabilities([]);
  const ok = async (worker: WorkerCredential, route: string, body: unknown) => {
    const response = await request(worker, route, body);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.value)}`);
    return response.value;
  };
  const execute = async (
    worker: WorkerCredential,
    assignment: ExecutionAssignment,
    abort = new AbortController(),
    /** Called once the server handed out the secrets: the process is about to start. */
    started?: () => void,
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
          started?.();
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
  try {
    const a = await issue("worker-a");
    const b = await issue("worker-b");
    const name = `dispatch-proof-${id}`;
    await deploy(name);
    const runId = await enqueue(name, { message: "one owner" });
    await delay(1_100);
    const queued = await platform.getPlatformRun(runId);
    assert.equal(queued.status, "queued");
    assert.equal(queued.executions.length, 0);
    assert.equal(queued.config.runtime.queue_timeout, "24h");
    console.log(`A1 offline: ${runId} queued, zero executions, default wait 24h.`);
    const stopA = new AbortController();
    const stopB = new AbortController();
    const resultA = pull(a, stopA.signal).then((assignment) => ({
      worker: a,
      assignment,
      stopOther: stopB,
    }));
    const resultB = pull(b, stopB.signal).then((assignment) => ({
      worker: b,
      assignment,
      stopOther: stopA,
    }));
    void resultA.catch(() => {});
    void resultB.catch(() => {});
    const winner = await Promise.race([resultA, resultB]);
    winner.stopOther.abort();
    await Promise.allSettled([resultA, resultB]);
    assert.ok(winner.assignment !== null);
    assert.equal(winner.assignment.lease.runId, runId);
    assert.equal((await platform.getPlatformRun(runId)).executions.length, 1);
    const report = await execute(winner.worker, winner.assignment);
    await finish(winner.worker, winner.assignment, report);
    const finished = await wait(runId, "succeeded");
    assert.deepEqual(finished.result, {
      message: "one owner",
      db: false,
      queue: false,
      masterKey: false,
    });
    assert.equal(finished.executions.length, 1);
    assert.equal(finished.executions[0]?.metadata.workerId, winner.worker.worker.id);
    assert.equal(finished.executions[0]?.workerName, winner.worker.worker.name);
    assert.equal(finished.executions[0]?.metadata.generation, winner.assignment.lease.generation);
    await finish(winner.worker, winner.assignment, report);
    console.log(
      `A1/A2 online race: one assignment and one execution; ${runId} succeeded; duplicate completion accepted.`,
    );

    // Source and secrets answer only the attempt a worker owns now.
    const scopedName = `secret-scope-${id}`;
    await platform.upsertSecret("SCOPED_KEY", `scoped-value-${id}`, {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    await writeFile(
      path.join(directory, "config.yaml"),
      `name: ${scopedName}\nversion: 1.0.0\nentrypoint: main.js\nsecrets: [SCOPED_KEY]\ntrigger:\n  type: webhook\n  path: /${scopedName}\nruntime:\n  profile: ${profile}\napi_check:\n  mode: passive\n`,
    );
    await writeFile(
      path.join(directory, "main.js"),
      "console.log(JSON.stringify({ length: process.env.SCOPED_KEY.length }));",
    );
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
    const scopedId = await enqueue(scopedName, {});
    const owned = await pullRun(a, scopedId);
    assert.ok(!JSON.stringify(owned).includes(`scoped-value-${id}`));
    for (const route of ["source", "start"]) {
      const refused = await request(b, route, { lease: ref(owned.lease) });
      assert.equal(refused.status, 409, `${route} must refuse another worker's attempt`);
      assert.ok(!JSON.stringify(refused.value).includes(`scoped-value-${id}`));
    }
    const scopedReport = await execute(a, owned);
    assert.deepEqual(JSON.parse(scopedReport.stdout), { length: `scoped-value-${id}`.length });
    await finish(a, owned, scopedReport);
    await wait(scopedId, "succeeded");
    for (const route of ["source", "start"])
      assert.equal((await request(a, route, { lease: ref(owned.lease) })).status, 409);
    console.log(
      `A2 scope: ${scopedId} delivered its secret only to the owner; another worker and the finished lease got HTTP 409 for source and start.`,
    );

    // Output and renewals take no lock on the worker row, which a claim holds while it counts the
    // worker's slots, so a worker's running attempts do not queue behind its claims.
    const unlockedId = await enqueue(name, { message: "unlocked" });
    const unlocked = await pullRun(a, unlockedId);
    await ok(a, "source", { lease: ref(unlocked.lease) });
    await ok(a, "start", { lease: ref(unlocked.lease) });
    const claimLock = await client.pool.connect();
    try {
      await claimLock.query("BEGIN");
      await claimLock.query("SELECT id FROM workers WHERE id = $1 FOR UPDATE", [a.worker.id]);
      const calls = [
        ["output", { sequence: 1, stream: "stderr", chunk: "under a claim lock\n" }],
        ["lease/renew", {}],
      ] as const;
      for (const [route, body] of calls) {
        const answered: { readonly status: number | string } = await request(
          a,
          route,
          { lease: ref(unlocked.lease), ...body },
          AbortSignal.timeout(3_000),
        ).catch((error: unknown) => ({ status: String(error), value: null }));
        assert.equal(answered.status, 200, `${route} waited for the claim's worker row lock`);
      }
    } finally {
      await claimLock.query("ROLLBACK");
      claimLock.release();
    }
    await finish(a, unlocked, {
      exitCode: 0,
      stdout: '{"message":"unlocked"}',
      stderr: "under a claim lock\n",
      durationMs: 1,
      failure: null,
    });
    assert.deepEqual((await wait(unlockedId, "succeeded")).result, { message: "unlocked" });
    console.log(
      `A2 lock: ${unlockedId} took output and a renewal while another transaction held its worker row.`,
    );

    // A delivery lost before start spends no attempt, even on the run's only attempt.
    const onceName = `unstarted-${id}`;
    await deploy(onceName, profile, undefined, "  retry:\n    max_attempts: 1\n");
    const unstartedId = await enqueue(onceName, { message: "delivered twice" });
    const abandoned = await pullRun(a, unstartedId);
    const requeued = await wait(unstartedId, "queued");
    assert.equal(requeued.attemptsMade, 0);
    // Its job goes back on the queue with the whole budget, the attempt it did not spend included.
    const unstartedQueue = new Queue(createQueueNameForProfile(profile), {
      connection: createBullMqConnection(process.env.VALKEY_URL ?? "redis://localhost:6379"),
    });
    try {
      const deadline = Date.now() + 15_000;
      let job = await unstartedQueue.getJob(requeued.queueJobId);
      while (job === undefined && Date.now() < deadline) {
        await delay(30);
        job = await unstartedQueue.getJob(requeued.queueJobId);
      }
      assert.equal(
        job?.opts.attempts,
        1,
        "the requeued job counts the delivery lost before start as a spent attempt",
      );
    } finally {
      await unstartedQueue.close();
    }
    const redelivered = await pullRun(b, unstartedId);
    assert.equal(redelivered.lease.generation, abandoned.lease.generation + 1);
    await finish(b, redelivered, await execute(b, redelivered));
    const delivered = await wait(unstartedId, "succeeded");
    // The redelivery spends the attempt the lost delivery did not.
    assert.deepEqual(
      delivered.executions.map((execution) => [
        execution.status,
        execution.errorCode,
        execution.attempt,
      ]),
      [
        ["retrying", "WORKER_LOST_BEFORE_START", 1],
        ["succeeded", null, 1],
      ],
    );
    console.log(
      `A3 unstarted: ${unstartedId} lost its first delivery, went back on the queue with its single attempt and succeeded on worker b.`,
    );
    // Only one delivery per attempt is free: a worker that never starts still spends the attempt.
    const neverStartedId = await enqueue(onceName, { message: "never started" });
    for (const status of ["queued", "dead-lettered"]) {
      await pullRun(a, neverStartedId);
      await wait(neverStartedId, status);
    }
    assert.deepEqual(
      (await platform.getPlatformRun(neverStartedId)).executions.map((execution) => [
        execution.status,
        execution.errorCode,
      ]),
      [
        ["retrying", "WORKER_LOST_BEFORE_START"],
        ["dead-lettered", "WORKER_LEASE_LOST"],
      ],
    );
    console.log(
      `A3 unstarted bound: ${neverStartedId} lost two deliveries before start; the second spent its single attempt.`,
    );

    // The local worker serves a project created after it was provisioned, without a grant; an
    // enrolled worker with the same group keeps to its grant.
    const localCredential = await createPostgresApiTokenStore({ client }).verifyToken(localToken);
    assert.ok(localCredential?.holder.kind === "worker");
    const local = {
      worker: await registry.authenticate(localCredential.holder.workerId, localCredential.id),
      token: localToken,
    };
    // Enrolled directly, so cleanup leaves the shared host-default queue to `just dev`.
    const remote = await registry.enroll(
      (
        await registry.create({
          name: `default-only-${id}`,
          services: [],
          profiles: ["host-default"],
          capacity: 1,
          issuedBy: null,
          environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "local" }],
        })
      ).code,
      `default-only-${id}`,
    );
    credentials.push(remote);
    const later = await createPostgresAccessStore({ client }).createProject({
      slug: `later-${id}`,
      name: `Later ${id}`,
    });
    const laterName = `later-project-${id}`;
    await writeFile(
      path.join(directory, "config.yaml"),
      `name: ${laterName}\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /${laterName}\n`,
    );
    await writeFile(
      path.join(directory, "main.js"),
      'console.log(JSON.stringify({ served: "later" }));',
    );
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
      project: async () => later.id,
    });
    const laterId = await enqueue(laterName, {});
    await assert.rejects(pull(remote, AbortSignal.timeout(1_500)), { name: "TimeoutError" });
    assert.equal((await platform.getPlatformRun(laterId)).status, "queued");
    const served = await pullRun(local, laterId);
    await finish(local, served, await execute(local, served));
    assert.deepEqual((await wait(laterId, "succeeded")).result, { served: "later" });
    console.log(
      `Local reach: ${laterId} in project ${later.slug}, created after the API started, ran on the local worker; the Default-only worker never received it.`,
    );

    const offlineProfile = `offline-${id}`;
    await issue("never-online", [offlineProfile]);
    const timeoutName = `placement-timeout-${id}`;
    await deploy(timeoutName, offlineProfile, "300ms");
    const timedOutId = await enqueue(timeoutName, { message: "never execute" });
    const timeout = await wait(timedOutId, "dead-lettered");
    assert.equal(timeout.errorCode, "PLACEMENT_TIMEOUT");
    assert.equal(
      timeout.errorMessage,
      `No live worker served project "Default" in local for group "${offlineProfile}" within 300ms. An owner or admin grants a worker under Settings > Workers, or with swizzle worker create <name> --project ${DEFAULT_PROJECT_ID} --environment local --groups ${offlineProfile}.`,
    );
    assert.equal(timeout.executions.length, 0);
    console.log(
      `A1 placement: ${timedOutId} dead-lettered with PLACEMENT_TIMEOUT naming its project and how to grant a worker, zero executions, no fallback.`,
    );

    const lostId = await enqueue(name, { message: "recovered", delayMs: 1_000 });
    const lost = await pullRun(a, lostId);
    await createPostgresControlPlaneStore({ client }).recordRunEnqueueError(
      lostId,
      "publication acknowledgement lost",
    );
    const stillOwned = await platform.getPlatformRun(lostId);
    assert.equal(stillOwned.status, "running");
    assert.equal(stillOwned.errorCode, null);
    const interrupted = new AbortController();
    let started = () => {};
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = execute(a, lost, interrupted, started);
    // A failure before start rejects here instead of leaving the wait unresolved.
    await Promise.race([start, running]);
    await delay(300);
    interrupted.abort();
    const oldReport = await running;
    await wait(lostId, "queued");
    const replacement = await pullRun(b, lostId);
    assert.equal(replacement.lease.generation, lost.lease.generation + 1);
    const stale = await request(a, "complete", { lease: ref(lost.lease), report: oldReport });
    assert.equal(stale.status, 409);
    const replacementReport = await execute(b, replacement);
    await finish(b, replacement, replacementReport);
    const recovered = await wait(lostId, "succeeded");
    assert.deepEqual(
      recovered.executions.map((execution) => execution.status),
      ["retrying", "succeeded"],
    );
    assert.equal(recovered.executions[0]?.errorCode, "WORKER_LEASE_LOST");
    assert.deepEqual(recovered.result, {
      message: "recovered",
      db: false,
      queue: false,
      masterKey: false,
    });
    console.log(
      `A2/A3 loss: ${lostId} retried in the same group, generation ${lost.lease.generation} -> ${replacement.lease.generation}; stale completion HTTP 409.`,
    );

    // Slow source/credential preparation must not hold the worker ownership lock.
    const slowId = await enqueue(name, { message: "prepared after delay" });
    const blocker = await client.pool.connect();
    let slowPull: Promise<ExecutionAssignment | null> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE automation_timeout_grants IN ACCESS EXCLUSIVE MODE");
      slowPull = pull(a);
      const preparing = await wait(slowId, "running");
      assert.equal(preparing.executions.at(-1)?.phase, "preparing");
      await delay(4_000); // Longer than this API's 3-second lease.
      const rows = await client.pool.query(
        "SELECT expires_at > now() AS valid FROM execution_leases WHERE run_id=$1 AND NOT released",
        [slowId],
      );
      assert.equal(rows.rows[0]?.valid, true, "server must renew while preparation is blocked");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const prepared = await slowPull;
    assert.ok(prepared != null);
    assert.equal(prepared.lease.runId, slowId);
    await finish(a, prepared, await execute(a, prepared));
    console.log(
      "Preparation: ownership renewed beyond initial lease while a database read waited; final assignment fenced.",
    );

    // A bounded admission rechecks the placement deadline before spending an attempt.
    const deadlineName = `admission-deadline-${id}`;
    await deploy(deadlineName, profile, "300ms");
    const deadlineId = await enqueue(deadlineName, {});
    const direct = createPostgresDispatchStore({ client, leaseMs: 3_000 });
    assert.equal(
      await direct.claim(a.worker, deadlineId, async () => {
        await delay(400);
        return true;
      }),
      null,
    );
    assert.equal((await platform.getPlatformRun(deadlineId)).executions.length, 0);
    await wait(deadlineId, "dead-lettered");
    console.log("Admission: placement deadline crossing consumes no attempt.");

    // Terminal recovery resumes an invoked parent even when the child's last owner vanishes.
    const childName = `lost-child-${id}`;
    await deploy(childName, profile, undefined, "  retry:\n    max_attempts: 1\n");
    const person = await client.pool.query<{ id: string }>(
      "INSERT INTO auth_users (name,email,role) VALUES ($1,$2,'owner') RETURNING id",
      ["Dispatch proof", `dispatch-${id}@proof.invalid`],
    );
    const userId = person.rows[0]?.id;
    assert.ok(userId !== undefined);
    const childAutomation = await platform.findAutomation(childName);
    assert.ok(childAutomation !== null);
    await platform.createNotificationRule({
      environment: "local",
      automationId: childAutomation.automationId,
      projectId: DEFAULT_PROJECT_ID,
      userId,
      chatId: "local-proof",
      eventType: "dead-lettered",
    });
    const parentName = `lost-parent-${id}`;
    await deployParent(parentName, childName);
    const parentId = await enqueue(parentName, {});
    const parent = await pullRun(a, parentId);
    await finish(a, parent, await execute(a, parent));
    await wait(parentId, "waiting");
    const child = await pull(a);
    assert.ok(child !== null);
    assert.ok(child.lease.runId !== null);
    // The owner vanishes after it started: its only attempt is spent.
    await ok(a, "start", { lease: ref(child.lease) });
    await wait(child.lease.runId, "dead-lettered");
    const resumed = await pullRun(b, parentId);
    await finish(b, resumed, await execute(b, resumed));
    const parentResult = await wait(parentId, "succeeded");
    assert.equal(parentResult.resumeCount, 1);
    const deliveries = await platform.listNotificationDeliveries({ environment: "local" });
    assert.equal(deliveries.filter((delivery) => delivery.runId === child.lease.runId).length, 1);
    assert.deepEqual(parentResult.result, {
      automation: childName,
      errorCode: "WORKER_LEASE_LOST",
      result: null,
      runId: child.lease.runId,
      status: "dead-lettered",
    });
    console.log(
      "Recovery: an exhausted child lease resumes its parent once with the durable failure envelope.",
    );

    // A child no worker takes within its queue_timeout dead-letters and resumes its parent too.
    const unplacedName = `unplaced-child-${id}`;
    await deploy(unplacedName, offlineProfile, "300ms");
    const waiterName = `unplaced-parent-${id}`;
    await deployParent(waiterName, unplacedName);
    const waiterId = await enqueue(waiterName, {});
    const waiter = await pullRun(a, waiterId);
    await finish(a, waiter, await execute(a, waiter));
    await wait(waiterId, "waiting");
    const resumedWaiter = await pullRun(a, waiterId, AbortSignal.timeout(10_000));
    await finish(a, resumedWaiter, await execute(a, resumedWaiter));
    const waiterResult = await wait(waiterId, "succeeded");
    const unplacedId = (waiterResult.result as { runId: string }).runId;
    assert.deepEqual(waiterResult.result, {
      automation: unplacedName,
      errorCode: "PLACEMENT_TIMEOUT",
      result: null,
      runId: unplacedId,
      status: "dead-lettered",
    });
    console.log(
      `Recovery: ${unplacedId}, a child no worker took within its queue_timeout, dead-lettered with PLACEMENT_TIMEOUT and resumed its parent.`,
    );

    // More unavailable offers than BullMQ slots cannot hide reachable work in the same profile.
    const deniedName = `other-environment-${id}`;
    await deploy(deniedName);
    // The second environment has registered grants but neither of the claiming workers serves it.
    const unavailable = await registry.create({
      name: `unavailable-${id}`,
      services: [],
      profiles: [profile],
      capacity: 1,
      issuedBy: null,
      environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "unreachable" }],
    });
    const offline = await registry.enroll(unavailable.code, `unavailable-${id}`);
    credentials.push(offline);
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "unreachable",
    });
    const blockedIds = [];
    for (let index = 0; index < 70; index++)
      blockedIds.push(
        (
          await platform.enqueuePlatformRun({
            automationName: deniedName,
            environment: "unreachable",
            payload: {},
          })
        ).runId,
      );
    await delay(1_100);
    const reachableId = await enqueue(name, { message: "not starved" });
    const reachable = await pullRun(a, reachableId);
    await finish(a, reachable, await execute(a, reachable));
    assert.ok(
      (await Promise.all(blockedIds.map((id) => platform.getPlatformRun(id)))).every(
        (run) => run.status === "queued" && run.executions.length === 0,
      ),
    );
    for (const id of blockedIds) await platform.cancelPlatformRun(id);
    console.log("Admission: 70 unavailable jobs do not starve an eligible run in the same group.");

    const extraProfile = `extra-${id}`;
    const capacityWorker = await issue("capacity", [profile, extraProfile]);
    const extraName = `capacity-proof-${id}`;
    await deploy(extraName, extraProfile);
    const capacityFirstId = await enqueue(name, { message: "first slot" });
    const capacityFirst = await pullRun(capacityWorker, capacityFirstId);
    const capacitySecondId = await enqueue(extraName, { message: "shared slot" });
    const noSlot = new AbortController();
    const blockedPull = pull(capacityWorker, noSlot.signal);
    void blockedPull.catch(() => {});
    await delay(200);
    assert.equal((await platform.getPlatformRun(capacitySecondId)).executions.length, 0);
    noSlot.abort();
    await Promise.allSettled([blockedPull]);
    await finish(capacityWorker, capacityFirst, await execute(capacityWorker, capacityFirst));
    const capacitySecond = await pullRun(capacityWorker, capacitySecondId);
    await finish(capacityWorker, capacitySecond, await execute(capacityWorker, capacitySecond));
    console.log("Capacity: one slot across two profiles; denied claims spend no attempt.");

    // The claim itself reads the service health the worker reported last, not only the pull.
    const serviceEnrollment = await registry.create({
      name: `service-${id}`,
      profiles: [profile],
      services: [LOCAL_LLM_SERVICE],
      capacity: 1,
      issuedBy: null,
      environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "local" }],
    });
    const serviceWorker = await registry.enroll(serviceEnrollment.code, `service-${id}`);
    credentials.push(serviceWorker);
    // What a worker service reports: this host's capabilities and its service health.
    const reportService = async (health: "healthy" | "unhealthy") =>
      ok(serviceWorker, "runtime", {
        capabilities,
        services: { [LOCAL_LLM_SERVICE]: health },
        runImageDisk: null,
      });
    const serviceName = `service-proof-${id}`;
    await deploy(
      serviceName,
      profile,
      undefined,
      `  permissions:\n    services: [${LOCAL_LLM_SERVICE}]\n`,
    );
    await reportService("unhealthy");
    const serviceRunId = await enqueue(serviceName, { message: "needs the model" });
    assert.equal(await direct.claim(serviceWorker.worker, serviceRunId), null);
    assert.equal((await platform.getPlatformRun(serviceRunId)).executions.length, 0);
    await reportService("healthy");
    const healthyAssignment = await pullRun(serviceWorker, serviceRunId);
    await finish(serviceWorker, healthyAssignment, await execute(serviceWorker, healthyAssignment));
    console.log(
      "Services: an unhealthy local-llm report stops the claim of a run that needs it; a healthy one lets it run.",
    );

    await request(capacityWorker, "drain", { draining: true });
    const drainedId = await enqueue(extraName, { message: "after drain" });
    const stopDrain = new AbortController();
    const drainedPull = pull(capacityWorker, stopDrain.signal);
    void drainedPull.catch(() => {});
    await delay(200);
    assert.equal((await platform.getPlatformRun(drainedId)).executions.length, 0);
    stopDrain.abort();
    await Promise.allSettled([drainedPull]);
    await request(capacityWorker, "drain", { draining: false });
    const afterDrain = await pull(capacityWorker);
    assert.ok(afterDrain !== null);
    await finish(capacityWorker, afterDrain, await execute(capacityWorker, afterDrain));
    console.log("Drain: no new assignment until resumed.");

    const cancelId = await enqueue(extraName, { message: "cancelled", delayMs: 2_000 });
    const cancelled = await pullRun(capacityWorker, cancelId);
    await platform.cancelPlatformRun(cancelId);
    assert.equal(
      (await request(capacityWorker, "lease/renew", { lease: ref(cancelled.lease) })).status,
      409,
    );
    assert.equal(
      (
        await request(capacityWorker, "output", {
          lease: ref(cancelled.lease),
          sequence: 1,
          stream: "stderr",
          chunk: "late",
        })
      ).status,
      409,
    );
    assert.equal(
      (await request(capacityWorker, "complete", { lease: ref(cancelled.lease), report })).status,
      409,
    );
    assert.equal((await platform.getPlatformRun(cancelId)).status, "dead-lettered");
    console.log("Cancel: renew, output and completion rejected after durable cancellation.");

    const rateName = `rate-proof-${id}`;
    await deploy(rateName, extraProfile, undefined, `  rate_limits:\n    rate-${id}: 1/sec\n`);
    const rateFirstId = await enqueue(rateName, { message: "rate first" });
    const rateFirst = await pullRun(capacityWorker, rateFirstId);
    const rateWorker = await issue("rate-worker", [extraProfile]);
    const rateSecondId = await enqueue(rateName, { message: "rate second" });
    const ratePending = pull(rateWorker);
    await delay(100);
    assert.equal((await platform.getPlatformRun(rateSecondId)).executions.length, 0);
    await finish(capacityWorker, rateFirst, await execute(capacityWorker, rateFirst));
    const rateSecond = await ratePending;
    assert.ok(rateSecond !== null);
    await finish(rateWorker, rateSecond, await execute(rateWorker, rateSecond));
    console.log("Rate limits: blocked run stays queued without an attempt, then starts.");

    // Delete only this proof's queue, while the API is down. Other worktrees keep their queues.
    const queueLostId = await enqueue(name, { message: "queue rebuilt" });
    await api.close();
    const queue = new Queue(createQueueNameForProfile(profile), {
      connection: createBullMqConnection(process.env.VALKEY_URL ?? "redis://localhost:6379"),
    });
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
    }
    api = await startVerificationApi({ ...process.env, SWIZZLE_WORKER_LEASE_MS: "3000" });
    await finish(b, replacement, replacementReport);
    const rebuilt = await pullRun(a, queueLostId);
    await finish(a, rebuilt, await execute(a, rebuilt));
    assert.equal((await wait(queueLostId, "succeeded")).executions.length, 1);
    console.log(
      "Restart/queue loss: durable queued work rebuilt; completed result receipt survived restart.",
    );

    // An attempt in flight survives an API restart: the real worker keeps its process running,
    // renews against the restarted API on the same address and delivers output and result to it.
    const restartProfile = `restart-${id}`;
    const restartCredential = await issue("restart", [restartProfile]);
    const restartName = `restart-in-flight-${id}`;
    await writeFile(
      path.join(directory, "config.yaml"),
      `name: ${restartName}\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /${restartName}\nruntime:\n  profile: ${restartProfile}\n`,
    );
    await writeFile(
      path.join(directory, "main.js"),
      `console.error('before restart'); await new Promise(resolve => setTimeout(resolve, 8000)); console.error('after restart'); console.log(JSON.stringify({ survived: true }));`,
    );
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
    const port = await freePort();
    const restartEnvironment = {
      ...process.env,
      API_PORT: String(port),
      SWIZZLE_WORKER_LEASE_MS: "10000",
    };
    await api.close();
    api = await startVerificationApi(restartEnvironment);
    const restartWorker = await startPlatformWorkerService({
      apiUrl: api.url,
      credential: { kind: "configured", token: restartCredential.token },
      capabilities,
      concurrency: 1,
    });
    try {
      const restartId = await enqueue(restartName, {});
      for (const deadline = Date.now() + 15_000; ; await delay(50)) {
        const run = await platform.getPlatformRun(restartId);
        if (run.executions[0]?.stderr.includes("before restart")) break;
        assert.ok(Date.now() < deadline, `run ${restartId} printed nothing: ${run.status}`);
      }
      await api.close();
      api = await startVerificationApi(restartEnvironment);
      const survived = await wait(restartId, "succeeded");
      assert.deepEqual(survived.result, { survived: true });
      assert.deepEqual(
        survived.executions.map((execution) => [execution.status, execution.metadata.generation]),
        [["succeeded", 1]],
        "the attempt must survive the restart instead of running again",
      );
      assert.match(survived.executions[0]?.stderr ?? "", /before restart\n[\s\S]*after restart/);
      console.log(
        `Restart in flight: ${restartId} kept its one attempt and generation through an API restart; output and result reached the restarted API.`,
      );
    } finally {
      await restartWorker.close();
    }
    const checkName = `check-protocol-${id}`;
    await platform.upsertSecret("CHECK_KEY", "scoped-check-value", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    const checkStore = createPostgresControlPlaneStore({ client });
    const connection = await checkStore.beginConnectionAuthorization({
      clientId: "check-client",
      clientSecret: "check-client-secret",
      codeVerifier: "check-verifier",
      environment: "local",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      name: "check-oauth",
      projectId: DEFAULT_PROJECT_ID,
      provider: "google",
      reauthorizes: null,
      redirectUri: "https://api.example.com/connections/google/callback",
      scopes: [],
      stateHash: `check-state-${id}`,
    });
    await checkStore.storeConnectionTokens({
      connectionId: connection.id,
      payload: {
        accessToken: "check-access-token",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        obtainedAt: new Date().toISOString(),
        refreshToken: null,
        tokenType: "Bearer",
      },
    });
    await writeFile(
      path.join(directory, "config.yaml"),
      `name: ${checkName}\nversion: 1.0.0\nentrypoint: main.js\nsecrets: [CHECK_KEY]\nconnections: [check-oauth]\ntrigger:\n  type: webhook\n  path: /${checkName}\nruntime:\n  profile: ${profile}\napi_check:\n  mode: active\n  entrypoint: check.js\n`,
    );
    await writeFile(
      path.join(directory, "check.js"),
      `console.log(JSON.stringify({ok:process.env.CHECK_KEY==='scoped-check-value',checked:['declared secret'],infrastructure:!!(process.env.DATABASE_URL||process.env.VALKEY_URL||process.env.SWIZZLE_ENCRYPTION_KEY),state:!!(process.env.SWIZZLE_STATE_FILE||process.env.SWIZZLE_STEPS_FILE)}));`,
    );
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
    assert.equal(await platform.enqueueDueApiChecks({ environment: "local" }), 1);
    const check = await pull(a);
    assert.ok(check !== null);
    assert.equal(check.script, "check");
    assert.ok(check.lease.checkId !== null);
    const checkReport = await execute(a, check);
    assert.deepEqual(JSON.parse(checkReport.stdout), {
      ok: true,
      checked: ["declared secret"],
      infrastructure: false,
      state: false,
    });
    await finish(a, check, checkReport);
    const recorded = await checkStore.getAutomationCheck(check.lease.checkId);
    assert.ok(recorded !== null);
    assert.equal(recorded.status, "green");
    assert.equal(recorded.lastSecretUsages[0]?.secretName, "CHECK_KEY");
    assert.deepEqual(
      recorded.lastConnectionUsages.map(({ injectedAt: _, ...usage }) => usage),
      [
        {
          connectionName: "check-oauth",
          environment: "local",
          provider: "google",
          tokenVersion: 1,
        },
      ],
    );
    console.log(
      "A4 checks: same HTTP protocol executes an active check with declared secrets, no infrastructure credentials, and no state/step files, and records the connection token version it received.",
    );
  } finally {
    await api.close();
    for (const profile of profilesOwned) {
      const queue = new Queue(createQueueNameForProfile(profile), {
        connection: createBullMqConnection(process.env.VALKEY_URL ?? "redis://localhost:6379"),
      });
      try {
        await queue.obliterate({ force: true });
      } finally {
        await queue.close();
      }
    }
    for (const credential of credentials) await registry.revoke(credential.worker.id, null);
    await Promise.all([
      registry.close(),
      platform.close(),
      rm(directory, { force: true, recursive: true }),
    ]);
  }
}
await withVerificationDatabase(main);

await withVerificationDatabase(verifyRunImages);
