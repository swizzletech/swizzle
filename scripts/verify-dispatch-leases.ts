import assert from "node:assert/strict";
import { mock } from "node:test";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { createPostgresControlPlaneStore } from "@swizzle/db/postgres";
import type { ExecutionAssignment } from "@swizzle/runtime/platform";
import { type DispatchFixture, waitFor, waitForLockWaiter } from "./verify-dispatch-fixture.js";

export async function verifyLeases(
  fixture: DispatchFixture,
  setScenario: (scenario: string) => void,
) {
  const {
    client,
    id,
    profile,
    directory,
    platform,
    registry,
    trackWorker,
    direct,
    queue,
    issue,
    deploy,
    deployParent,
    enqueue,
    pull,
    pullRun,
    wait,
    execute,
    finish,
    expireLease,
    request,
    ok,
    ref,
  } = fixture;
  const a = await issue("worker-a");
  const b = await issue("worker-b");
  const name = `dispatch-proof-${id}`;
  await deploy(name);
  setScenario("lease loss and stale completion");
  const lostId = await enqueue(name, { message: "recovered", holdFirst: true });
  const lost = await pullRun(a, lostId);
  await createPostgresControlPlaneStore({ client }).recordRunEnqueueError(
    lostId,
    "publication acknowledgement lost",
  );
  const stillOwned = await platform.getPlatformRun(lostId);
  assert.equal(stillOwned.status, "running");
  assert.equal(stillOwned.errorCode, null);
  const interrupted = new AbortController();
  let outputPublished = () => {};
  const firstOutput = new Promise<void>((resolve) => {
    outputPublished = resolve;
  });
  const running = execute(a, lost, interrupted, outputPublished);
  await Promise.race([
    firstOutput,
    running.then(() => assert.fail("The first attempt exited before it published output.")),
  ]);
  interrupted.abort();
  const oldReport = await running;
  await expireLease(lost);
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

  setScenario("renewal during preparation");
  const slowId = await enqueue(name, { message: "prepared after delay" });
  const blocker = await client.pool.connect();
  let slowPull: Promise<ExecutionAssignment | null> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE automation_timeout_grants IN ACCESS EXCLUSIVE MODE");
    slowPull = pull(a);
    const done = new AbortController();
    const blocked = waitForLockWaiter(blocker, done.signal);
    try {
      await Promise.race([
        blocked,
        slowPull.then(() => assert.fail("Pull returned before the preparation lock was released.")),
      ]);
    } finally {
      done.abort();
      await Promise.allSettled([blocked]);
    }
    const preparing = await platform.getPlatformRun(slowId);
    assert.equal(preparing.status, "running");
    assert.equal(preparing.executions.at(-1)?.phase, "preparing");
    const expiry = async () => {
      const rows = await client.pool.query<{ expires_at: Date }>(
        "SELECT expires_at FROM execution_leases WHERE run_id = $1 AND NOT released",
        [slowId],
      );
      const expiresAt = rows.rows[0]?.expires_at;
      assert.ok(expiresAt !== undefined, "preparation lost its lease while waiting on the lock");
      return expiresAt;
    };
    const initialExpiry = await expiry();
    await waitFor(async () => (await expiry()) > initialExpiry);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const prepared = await slowPull;
  assert.ok(prepared != null);
  assert.equal(prepared.lease.runId, slowId);
  await finish(a, prepared, await execute(a, prepared));
  console.log(
    "Preparation: ownership renewed while a database read waited; final assignment fenced.",
  );

  setScenario("placement deadline during admission");
  const deadlineName = `admission-deadline-${id}`;
  await deploy(deadlineName);
  const deadlineId = await enqueue(deadlineName, {});
  const deadlineRow = await client.pool.query<{ placement_deadline_at: Date }>(
    "SELECT placement_deadline_at FROM runs WHERE id = $1",
    [deadlineId],
  );
  const deadlineAt = deadlineRow.rows[0]?.placement_deadline_at;
  assert.ok(deadlineAt !== undefined);
  mock.timers.enable({ apis: ["Date"], now: deadlineAt.getTime() - 1 });
  try {
    await registry.heartbeat(a.worker);
    let admitted = false;
    assert.equal(
      await direct.claim(a.worker, deadlineId, async () => {
        admitted = true;
        mock.timers.setTime(deadlineAt.getTime());
        return true;
      }),
      null,
    );
    assert.equal(admitted, true);
  } finally {
    mock.timers.reset();
    await registry.heartbeat(a.worker);
  }
  await client.pool.query(
    "UPDATE runs SET placement_deadline_at = CURRENT_TIMESTAMP WHERE id = $1",
    [deadlineId],
  );
  assert.equal((await platform.getPlatformRun(deadlineId)).executions.length, 0);
  await wait(deadlineId, "dead-lettered");
  console.log("Admission: placement deadline crossing consumes no attempt.");

  setScenario("parent recovery after a child loses its lease");
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
  await deployParent(parentName, childName, 4_000);
  const parentId = await enqueue(parentName, {});
  const parent = await pullRun(a, parentId);
  await finish(a, parent, await execute(a, parent));
  await wait(parentId, "waiting");
  const child = await pull(a);
  assert.ok(child !== null);
  assert.ok(child.lease.runId !== null);
  await ok(a, "start", { lease: ref(child.lease) });
  await expireLease(child);
  await wait(child.lease.runId, "dead-lettered");
  const resumed = await pullRun(b, parentId);
  await finish(b, resumed, await execute(b, resumed));
  const parentResult = await wait(parentId, "succeeded");
  assert.equal(parentResult.resumeCount, 1);
  assert.deepEqual(
    parentResult.executions.map((execution) => [execution.status, execution.workerName]),
    [
      ["suspended", a.worker.name],
      ["succeeded", b.worker.name],
    ],
  );
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

  setScenario("parent recovery after a child misses placement");
  const offlineProfile = `offline-${id}`;
  await issue("never-online", [offlineProfile]);
  const unplacedName = `unplaced-child-${id}`;
  await deploy(unplacedName, offlineProfile);
  const waiterName = `unplaced-parent-${id}`;
  await deployParent(waiterName, unplacedName);
  const waiterId = await enqueue(waiterName, {});
  const waiter = await pullRun(a, waiterId);
  await finish(a, waiter, await execute(a, waiter));
  await wait(waiterId, "waiting");
  const unplacedChild = await client.pool.query<{ id: string }>(
    "UPDATE runs SET placement_deadline_at = CURRENT_TIMESTAMP WHERE parent_run_id = $1 AND status = 'queued' RETURNING id",
    [waiterId],
  );
  const unplacedId = unplacedChild.rows[0]?.id;
  assert.ok(unplacedId !== undefined);
  await wait(unplacedId, "dead-lettered");
  await wait(waiterId, "queued");
  const resumedWaiter = await pullRun(a, waiterId);
  await finish(a, resumedWaiter, await execute(a, resumedWaiter));
  const waiterResult = await wait(waiterId, "succeeded");
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

  setScenario("queue fairness");
  const deniedName = `other-environment-${id}`;
  await deploy(deniedName);
  const unavailable = await registry.create({
    name: `unavailable-${id}`,
    services: [],
    profiles: [profile],
    capacity: 1,
    issuedBy: null,
    environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "unreachable" }],
  });
  const offline = await registry.enroll(unavailable.code, `unavailable-${id}`);
  trackWorker(offline);
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
  await waitFor(async () => {
    const counts = await queue(profile).getJobCounts("active", "delayed");
    return (counts.active ?? 0) + (counts.delayed ?? 0) >= 64;
  });
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
}
