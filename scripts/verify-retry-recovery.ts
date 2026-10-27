import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQueueNameForProfile } from "@swizzle/runtime";
import type { PlatformServices } from "@swizzle/runtime/platform";
import { Queue } from "bullmq";

/** Called with the live workers of verify-multi-worker; never restarts them. */
export async function verifyRetryRecovery(
  platform: PlatformServices,
  profile: string,
): Promise<void> {
  const url = new URL(process.env.VALKEY_URL ?? "redis://localhost:6379");
  const queue = new Queue(createQueueNameForProfile(profile), {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: decodeURIComponent(url.password),
    },
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-worker-retry-"));
  try {
    for (const resumed of [false, true]) {
      const name = `retry-recovery-${resumed ? "resumed" : "initial"}`;
      await writeFile(
        path.join(directory, "config.yaml"),
        [
          `name: ${name}`,
          "version: 1.0.0",
          "entrypoint: main.js",
          "trigger:",
          "  type: webhook",
          `  path: /${name}`,
          "runtime:",
          `  profile: ${profile}`,
          "  retry:",
          "    max_attempts: 3",
          "    backoff: exponential",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(directory, "main.js"),
        resumed
          ? `if (process.env.SWIZZLE_EXECUTION === "1") {
          console.log(JSON.stringify({ $swizzle: { suspend: { reason: "sleep", stepKey: "nap", until: "2000-01-01T00:00:00.000Z" } } }));
        } else { process.exit(1); }`
          : "process.exit(1);",
      );
      await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: directory,
      });
      const runId = randomUUID();
      await platform.enqueuePlatformRun({ environment: "local", automationName: name, runId });
      if (resumed) {
        await waitForStatus(platform, runId, "waiting");
        await platform.resumeDueWaitingRuns({ environment: "local" });
      }
      const jobId = resumed ? `${runId}--s1` : runId;
      const deadline = Date.now() + 10_000;
      for (;;) {
        const job = await queue.getJob(jobId);
        const run = await platform.getPlatformRun(runId);
        if (
          job &&
          (await job.getState()) === "delayed" &&
          run.status === "queued" &&
          run.executions.at(-1)?.status === "retrying"
        ) {
          assert.equal(run.attemptsMade, 1);
          await job.remove();
          break;
        }
        assert.ok(Date.now() < deadline, `Did not find delayed retry for ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const recovery = await platform.reconcileQueuedRuns({ environment: "local" });
      assert.ok(recovery.requeuedRunIds.includes(runId), `${name} was not re-enqueued`);
      const recoveredJob = await queue.getJob(jobId);
      assert.equal(recoveredJob?.attemptsMade, 0);
      assert.equal(recoveredJob?.opts.attempts, 2);
      await waitForStatus(platform, runId, "dead-lettered");
      const terminal = await platform.getPlatformRun(runId);
      assert.equal(terminal.attemptsMade, 3);
      assert.deepEqual(
        terminal.executions.map((execution) => execution.status),
        resumed
          ? ["suspended", "retrying", "retrying", "dead-lettered"]
          : ["retrying", "retrying", "dead-lettered"],
      );
      assert.deepEqual(
        terminal.executions.map((execution) => [execution.executionNumber, execution.attempt]),
        resumed
          ? [
              [1, 1],
              [2, 1],
              [3, 2],
              [4, 3],
            ]
          : [
              [1, 1],
              [2, 2],
              [3, 3],
            ],
      );
      process.stdout.write(
        `Retry recovery (${resumed ? "resumed" : "initial"} segment): ${terminal.status}, ${terminal.executions.length} executions, ${terminal.attemptsMade} attempts in recovered segment.\n`,
      );
    }
  } finally {
    await queue.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForStatus(
  platform: PlatformServices,
  runId: string,
  status: "waiting" | "dead-lettered",
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const run = await platform.getPlatformRun(runId);
    if (run.status === status) return;
    assert.ok(
      Date.now() < deadline,
      `Expected ${status}, got ${run.status}: ${run.executions.map((execution) => execution.status)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
