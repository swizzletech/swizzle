import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { createPostgresAccessStore, createPostgresApiTokenStore } from "@swizzle/db/postgres";
import { type DispatchFixture, waitFor, waitForLockWaiter } from "./verify-dispatch-fixture.js";

export async function verifyClaims(
  fixture: DispatchFixture,
  setScenario: (scenario: string) => void,
) {
  const {
    client,
    id,
    directory,
    profile,
    platform,
    issue,
    deploy,
    enqueue,
    queue,
    pull,
    pullRun,
    wait,
    execute,
    finish,
    request,
    ok,
    ref,
    expireLease,
    localToken,
    registry,
    trackWorker,
    direct,
  } = fixture;
  setScenario("offline placement");
  const a = await issue("worker-a");
  const b = await issue("worker-b");
  const name = `dispatch-proof-${id}`;
  await deploy(name);
  const runId = await enqueue(name, { message: "one owner" });
  await waitFor(async () => (await queue(profile).getJobState(runId)) === "delayed");
  const queued = await platform.getPlatformRun(runId);
  assert.equal(queued.status, "queued");
  assert.equal(queued.executions.length, 0);
  assert.equal(queued.config.runtime.queue_timeout, "24h");
  console.log(`A1 offline: ${runId} queued, zero executions, default wait 24h.`);
  setScenario("competing claims and completion receipts");
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

  setScenario("source and secret scope");
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

  setScenario("output and renewal under a claim lock");
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
      const done = new AbortController();
      const answer = ok(a, route, { lease: ref(unlocked.lease), ...body }, done.signal);
      const blocked = waitForLockWaiter(claimLock, done.signal).then(() =>
        assert.fail(`${route} waited for the claim's worker row lock`),
      );
      try {
        await Promise.race([answer, blocked]);
      } finally {
        done.abort();
        await Promise.allSettled([answer, blocked]);
      }
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

  setScenario("one free redelivery before start");
  const onceName = `unstarted-${id}`;
  await deploy(onceName, profile, undefined, "  retry:\n    max_attempts: 1\n");
  const unstartedId = await enqueue(onceName, { message: "delivered twice" });
  const abandoned = await pullRun(a, unstartedId);
  await expireLease(abandoned);
  const requeued = await wait(unstartedId, "queued");
  assert.equal(requeued.attemptsMade, 0);
  await waitFor(async () => (await queue(profile).getJob(requeued.queueJobId)) !== undefined);
  assert.equal(
    (await queue(profile).getJob(requeued.queueJobId))?.opts.attempts,
    1,
    "the requeued job counts the delivery lost before start as a spent attempt",
  );
  const redelivered = await pullRun(b, unstartedId);
  assert.equal(redelivered.lease.generation, abandoned.lease.generation + 1);
  await finish(b, redelivered, await execute(b, redelivered));
  const delivered = await wait(unstartedId, "succeeded");
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
  setScenario("bounded loss before start");
  const neverStartedId = await enqueue(onceName, { message: "never started" });
  for (const status of ["queued", "dead-lettered"] as const) {
    await expireLease(await pullRun(a, neverStartedId));
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

  setScenario("local worker project access");
  const localCredential = await createPostgresApiTokenStore({ client }).verifyToken(localToken);
  assert.ok(localCredential?.holder.kind === "worker");
  const local = {
    worker: await registry.authenticate(localCredential.holder.workerId, localCredential.id),
    token: localToken,
  };
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
  trackWorker(remote);
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
  assert.equal(await pull(remote), null);
  assert.equal(await direct.claim(remote.worker, laterId), null);
  assert.equal((await platform.getPlatformRun(laterId)).status, "queued");
  const served = await pullRun(local, laterId);
  await finish(local, served, await execute(local, served));
  assert.deepEqual((await wait(laterId, "succeeded")).result, { served: "later" });
  console.log(
    `Local reach: ${laterId} in project ${later.slug}, created after the API started, ran on the local worker; the Default-only worker never received it.`,
  );

  setScenario("offline placement timeout");
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
}
