import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { isFinishedRun } from "@swizzle/db";
import { collectWorkerCapabilities } from "@swizzle/runtime";
import { startPlatformWorkerService } from "@swizzle/runtime/platform";
import { type DispatchFixture, waitFor } from "./verify-dispatch-fixture.js";

export async function verifyRestarts(
  fixture: DispatchFixture,
  setScenario: (scenario: string) => void,
) {
  const {
    id,
    profile,
    directory,
    platform,
    issue,
    deploy,
    enqueue,
    queue,
    pullRun,
    wait,
    execute,
    finish,
    stopApi,
    startApi,
  } = fixture;
  setScenario("queue reconstruction and completion receipts");
  const a = await issue("worker-a");
  const name = `dispatch-proof-${id}`;
  await deploy(name);
  const completedId = await enqueue(name, { message: "receipt retained" });
  const completed = await pullRun(a, completedId);
  const receipt = await execute(a, completed);
  await finish(a, completed, receipt);
  await wait(completedId, "succeeded");
  const queueLostId = await enqueue(name, { message: "queue rebuilt" });
  await stopApi();
  await queue(profile).obliterate({ force: true });
  await startApi();
  await finish(a, completed, receipt);
  const rebuilt = await pullRun(a, queueLostId);
  await finish(a, rebuilt, await execute(a, rebuilt));
  assert.equal((await wait(queueLostId, "succeeded")).executions.length, 1);
  console.log(
    "Restart/queue loss: durable queued work rebuilt; completed result receipt survived restart.",
  );

  setScenario("in-flight API restart");
  const restartProfile = `restart-${id}`;
  const restartCredential = await issue("restart", [restartProfile]);
  const restartName = `restart-in-flight-${id}`;
  const restartGate = path.join(directory, "restarted");
  await writeFile(
    path.join(directory, "config.yaml"),
    `name: ${restartName}\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /${restartName}\nruntime:\n  profile: ${restartProfile}\n`,
  );
  await writeFile(
    path.join(directory, "main.js"),
    `import { existsSync } from 'node:fs'; console.error('before restart'); while (!existsSync(${JSON.stringify(restartGate)})) await new Promise(resolve => setTimeout(resolve, 30)); console.error('after restart'); console.log(JSON.stringify({ survived: true }));`,
  );
  await platform.deployAutomationToPlatform({
    automationDirectory: directory,
    environment: "local",
  });
  const port = await freePort();
  const restartEnvironment = {
    ...process.env,
    API_PORT: String(port),
  };
  await stopApi();
  const api = await startApi(restartEnvironment);
  const restartWorker = await startPlatformWorkerService({
    apiUrl: api.url,
    credential: { kind: "configured", token: restartCredential.token },
    capabilities: await collectWorkerCapabilities([]),
    concurrency: 1,
  });
  try {
    const restartId = await enqueue(restartName, {});
    await waitFor(async () => {
      const run = await platform.getPlatformRun(restartId);
      assert.ok(!isFinishedRun(run.status), `run ${restartId} finished before the restart`);
      return run.executions[0]?.stderr.includes("before restart") ?? false;
    });
    await stopApi();
    await startApi(restartEnvironment);
    await writeFile(restartGate, "");
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
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("No free port.");
  return address.port;
}
