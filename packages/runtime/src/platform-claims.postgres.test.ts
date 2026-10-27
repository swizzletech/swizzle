import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture, repoRoot } from "../test/platform-harness.js";
import { runAutomation } from "./runner.js";

// Two deliveries of one order that run at the same time perform the side effect once.

describe.each([
  {
    entrypoint: "main.ts",
    main: [
      'import { appendFileSync } from "node:fs";',
      'import { claim, readPayload } from "./swizzle-sdk.ts";',
      "const order = await readPayload<{ id: string }>();",
      'const sent = await claim("order:" + order.id);',
      'if (sent) appendFileSync(process.env.SENT_FILE!, process.env.SWIZZLE_RUN_ID + "\\n");',
      "console.log(JSON.stringify({ sent }));",
    ],
    sdk: { source: "packages/sdk-ts/src/index.ts", copy: "swizzle-sdk.ts" },
  },
  {
    entrypoint: "main.py",
    main: [
      "import json, os",
      "from swizzle_sdk import claim, read_payload",
      "order = read_payload()",
      "sent = claim('order:' + order['id'])",
      "if sent:",
      "    with open(os.environ['SENT_FILE'], 'a') as sent_file:",
      "        sent_file.write(os.environ['SWIZZLE_RUN_ID'] + '\\n')",
      "print(json.dumps({'sent': sent}))",
    ],
    sdk: { source: "packages/sdk-py/swizzle_sdk.py", copy: "swizzle_sdk.py" },
  },
])("deduplication in $entrypoint", ({ entrypoint, main, sdk }) => {
  async function orderIntake() {
    const directory = await temporaryDirectory("swizzle-fixture-");
    const sentFile = path.join(await temporaryDirectory("swizzle-sent-"), "sent.txt");
    await writeFile(sentFile, "");
    await writeFile(
      path.join(directory, "config.yaml"),
      [
        "name: order-intake",
        "version: 1.0.0",
        `entrypoint: ${entrypoint}`,
        "trigger:",
        "  type: webhook",
        "  path: /order-intake",
        "vars:",
        `  SENT_FILE: ${sentFile}`,
        "",
      ].join("\n"),
    );
    await writeFile(path.join(directory, entrypoint), `${main.join("\n")}\n`);
    await copyFile(path.join(repoRoot, sdk.source), path.join(directory, sdk.copy));
    const sent = async () => (await readFile(sentFile, "utf8")).split("\n").filter(Boolean);
    return { directory, sent };
  }

  it("lets one of two concurrent deliveries of the same order send", async () => {
    const platform = await testPlatform();
    const automation = await orderIntake();
    await platform.deployAutomationToPlatform({
      automationDirectory: automation.directory,
      deploymentId: "5d0c7a0e-5b8f-5d43-9a43-3f1f6c1b8e21",
      environment: "local",
    });
    const deliveries = await Promise.all(
      [1, 2].map(() =>
        platform.triggerWebhookByPath({
          environment: "local",
          path: "/order-intake",
          payload: { id: "A-1001" },
        }),
      ),
    );

    // Both deliveries execute at once, as on a worker with WORKER_CONCURRENCY=2. A claim queues
    // its run again, so each run finishes in a later round.
    for (let round = 0; round < 3; round += 1) {
      await Promise.all([platform.processNextPlatformRun(), platform.processNextPlatformRun()]);
      await platform.reconcileQueuedRuns({});
    }

    const runs = await Promise.all(
      deliveries.map((delivery) => platform.getPlatformRun(delivery.runId)),
    );
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    // The first executions overlapped, so neither read state after the other had decided.
    const [first, second] = runs.map((run) => run.executions[0]);
    expect(String(first?.startedAt) < String(second?.finishedAt)).toBe(true);
    expect(String(second?.startedAt) < String(first?.finishedAt)).toBe(true);
    for (const run of runs)
      expect(run.executions.map((execution) => execution.status)).toEqual([
        "suspended",
        "succeeded",
      ]);
    expect(runs.map((run) => (run.result as { sent: boolean }).sent).sort()).toEqual([false, true]);
    const sender = runs.find((run) => (run.result as { sent: boolean }).sent)?.runId;
    expect(await automation.sent()).toEqual([sender]);
    const holder = await platform.getAutomationStateValue({
      automationName: "order-intake",
      environment: "local",
      key: "claim:order:A-1001",
    });
    expect(holder?.value).toEqual({ runId: sender });
  });

  it("sends from a local run, which holds no platform state", async () => {
    const automation = await orderIntake();
    const result = await runAutomation({
      automationDirectory: automation.directory,
      environmentName: "local",
      inlineJson: JSON.stringify({ id: "A-1001" }),
    });
    expect(result).toMatchObject({ result: { sent: true }, success: true });
    expect(await automation.sent()).toHaveLength(1);
  });
});

it("sends each claimed item of a loop once, though every first claim restarts the entrypoint", async () => {
  const platform = await testPlatform();
  const directory = await temporaryDirectory("swizzle-fixture-");
  const sentFile = path.join(await temporaryDirectory("swizzle-sent-"), "sent.txt");
  await writeFile(sentFile, "");
  await writeFile(
    path.join(directory, "config.yaml"),
    `name: order-batch\nversion: 1.0.0\nentrypoint: main.ts\ntrigger:\n  type: webhook\n  path: /order-batch\nvars:\n  SENT_FILE: ${sentFile}\n`,
  );
  await writeFile(
    path.join(directory, "main.ts"),
    [
      'import { appendFileSync } from "node:fs";',
      'import { claim, runStep } from "./swizzle-sdk.ts";',
      'for (const id of ["A-1", "A-2"]) {',
      '  if (await claim("order:" + id))',
      '    await runStep("send:" + id, () => appendFileSync(process.env.SENT_FILE!, id + "\\n"));',
      "}",
      "console.log(JSON.stringify({ ok: true }));",
      "",
    ].join("\n"),
  );
  await copyFile(
    path.join(repoRoot, "packages/sdk-ts/src/index.ts"),
    path.join(directory, "swizzle-sdk.ts"),
  );
  await platform.deployAutomationToPlatform({
    automationDirectory: directory,
    deploymentId: "0e1f8f3c-3a52-5d3e-8f61-6b4b0b8e4a17",
    environment: "local",
  });
  const queued = await platform.startManualRun({
    automationName: "order-batch",
    environment: "local",
    payload: {},
  });
  for (let round = 0; round < 3; round += 1) {
    await platform.processNextPlatformRun();
    await platform.reconcileQueuedRuns({});
  }

  const run = await platform.getPlatformRun(queued.runId);
  expect(run.status).toBe("succeeded");
  expect(run.executions).toHaveLength(3);
  expect((await readFile(sentFile, "utf8")).split("\n").filter(Boolean)).toEqual(["A-1", "A-2"]);
});

it("fails a run whose claim the full state store refuses", async () => {
  const platform = await testPlatform();
  const directory = await createAutomationFixture({
    mainJs: `process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: "claim", stepKey: "claim:A-1" } } }) + "\\n");\n`,
    name: "full-state",
    triggerLines: ["  type: webhook", "  path: /full-state"],
  });
  await platform.deployAutomationToPlatform({
    automationDirectory: directory,
    deploymentId: "8a3f0d4e-6c1b-5e2a-9d7f-2b4c6e8a0f13",
    environment: "local",
  });
  const value = "x".repeat(64 * 1024 - 2);
  for (let i = 0; i < 80; i += 1)
    await platform.setAutomationStateValue({
      automationName: "full-state",
      environment: "local",
      key: `seed-${i}`,
      value,
    });
  const queued = await platform.startManualRun({
    automationName: "full-state",
    environment: "local",
    payload: {},
  });

  const processed = await platform.processNextPlatformRun();
  expect(processed).toMatchObject({
    errorCode: "AUTOMATION_STATE_LIMIT_EXCEEDED",
    runId: queued.runId,
    status: "dead-lettered",
  });
});
