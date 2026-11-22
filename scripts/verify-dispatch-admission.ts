import assert from "node:assert/strict";
import { LOCAL_LLM_SERVICE } from "@swizzle/config";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { collectWorkerCapabilities } from "@swizzle/runtime";
import type { DispatchFixture } from "./verify-dispatch-fixture.js";

export async function verifyAdmission(
  fixture: DispatchFixture,
  setScenario: (scenario: string) => void,
) {
  const {
    id,
    profile,
    platform,
    registry,
    trackWorker,
    direct,
    issue,
    deploy,
    enqueue,
    pull,
    pullRun,
    wait,
    execute,
    finish,
    request,
    ok,
    ref,
  } = fixture;
  const name = `dispatch-proof-${id}`;
  const capabilities = await collectWorkerCapabilities([]);
  setScenario("shared worker capacity");
  const extraProfile = `extra-${id}`;
  const capacityWorker = await issue("capacity", [profile, extraProfile]);
  await deploy(name);
  const extraName = `capacity-proof-${id}`;
  await deploy(extraName, extraProfile);
  const capacityFirstId = await enqueue(name, { message: "first slot" });
  const capacityFirst = await pullRun(capacityWorker, capacityFirstId);
  const capacitySecondId = await enqueue(extraName, { message: "shared slot" });
  assert.equal(await pull(capacityWorker), null);
  assert.equal(await direct.claim(capacityWorker.worker, capacitySecondId), null);
  assert.equal((await platform.getPlatformRun(capacitySecondId)).executions.length, 0);
  await finish(capacityWorker, capacityFirst, await execute(capacityWorker, capacityFirst));
  const capacitySecond = await pullRun(capacityWorker, capacitySecondId);
  await finish(capacityWorker, capacitySecond, await execute(capacityWorker, capacitySecond));
  console.log("Capacity: one slot across two profiles; denied claims spend no attempt.");

  setScenario("worker service health");
  const serviceEnrollment = await registry.create({
    name: `service-${id}`,
    profiles: [profile],
    services: [LOCAL_LLM_SERVICE],
    capacity: 1,
    issuedBy: null,
    environments: [{ projectId: DEFAULT_PROJECT_ID, environment: "local" }],
  });
  const serviceWorker = await registry.enroll(serviceEnrollment.code, `service-${id}`);
  trackWorker(serviceWorker);
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

  setScenario("worker drain");
  await ok(capacityWorker, "drain", { draining: true });
  const drainedId = await enqueue(extraName, { message: "after drain" });
  assert.equal(await pull(capacityWorker), null);
  assert.equal((await platform.getPlatformRun(drainedId)).executions.length, 0);
  await ok(capacityWorker, "drain", { draining: false });
  const afterDrain = await pullRun(capacityWorker, drainedId);
  await finish(capacityWorker, afterDrain, await execute(capacityWorker, afterDrain));
  console.log("Drain: no new assignment until resumed.");

  setScenario("cancellation");
  const cancelId = await enqueue(extraName, { message: "cancelled" });
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
    (
      await request(capacityWorker, "complete", {
        lease: ref(cancelled.lease),
        report: { exitCode: 0, stdout: "{}", stderr: "", durationMs: 1, failure: null },
      })
    ).status,
    409,
  );
  assert.equal((await platform.getPlatformRun(cancelId)).status, "dead-lettered");
  console.log("Cancel: renew, output and completion rejected after durable cancellation.");

  setScenario("rate admission");
  const rateName = `rate-proof-${id}`;
  await deploy(rateName, extraProfile, undefined, `  rate_limits:\n    rate-${id}: 1/sec\n`);
  const rateWorker = await issue("rate-worker", [extraProfile]);
  const rateFirstId = await enqueue(rateName, { message: "rate first" });
  const rateFirst = await pullRun(capacityWorker, rateFirstId);
  const rateSecondId = await enqueue(rateName, { message: "rate second" });
  const rateSecond = await pullRun(rateWorker, rateSecondId);
  await finish(capacityWorker, rateFirst, await execute(capacityWorker, rateFirst));
  await finish(rateWorker, rateSecond, await execute(rateWorker, rateSecond));
  const firstRateRun = await wait(rateFirstId, "succeeded");
  const secondRateRun = await wait(rateSecondId, "succeeded");
  assert.equal(firstRateRun.executions.length, 1);
  assert.equal(secondRateRun.executions.length, 1);
  const [firstRateExecution] = firstRateRun.executions;
  const [secondRateExecution] = secondRateRun.executions;
  assert.ok(firstRateExecution && secondRateExecution);
  const startGapMs =
    Date.parse(secondRateExecution.startedAt) - Date.parse(firstRateExecution.startedAt);
  assert.ok(
    startGapMs >= 1_000,
    `Expected rate-limited starts at least 1000 ms apart, got ${startGapMs} ms.`,
  );
  console.log(`Rate limits: executions started ${startGapMs} ms apart with a 1/sec limit.`);
}
