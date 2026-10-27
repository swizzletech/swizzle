import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestExecution } from "../../../test/execution.js";
import { testControlPlaneStore } from "../../../test/stores.js";
import { temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";
import { createPlatformServiceFacade } from "./platform-service-facade.js";
import type { RunQueueProducer } from "./run-queue.js";
import { thisMachine } from "./runtime-requirements.js";

const RUN_ID = "ad881a21-0f5e-5fd9-b153-cddce37ee44b";

// A local platform with one run, RUN_ID, of an automation that retries up to three times.
// When `resumed`, attempt 1 sleeps and the run is resumed, so attempt 2 starts a new segment; every
// other attempt prints "attempt" to stderr and exits 1.
async function retryingRun(backoff: string, resumed: boolean) {
  const directory = await temporaryDirectory("swizzle-retry-recovery-");
  const store = testControlPlaneStore();
  const jobs = new Map<string, Parameters<RunQueueProducer["enqueue"]>[0]>();
  const queue: RunQueueProducer = {
    close: async () => {},
    enqueue: async (job) => {
      jobs.set(job.jobId, job);
    },
    enqueueCheck: async () => {},
    hasJob: async ({ jobId }) => jobs.has(jobId),
  };
  const platform = createPlatformServiceFacade({
    artifactsDirectory: path.join(directory, "artifacts"),
    checkReadiness: async () => {
      throw new Error("unused");
    },
    close: async () => {},
    listReadinessWorkers: async ({ config }) => [await thisMachine(config.runtime, "worker")],
    placeRun: async () => null,
    queue,
    runMaintenance: async () => {
      throw new Error("unused");
    },
    store,
  });
  const fails = `process.stderr.write("attempt\\n"); process.exit(1);`;
  const automationDirectory = await createAutomationFixture({
    name: "retry-recovery",
    triggerLines: ["  type: webhook", "  path: /retry-recovery"],
    configLines: ["runtime:", "  retry:", "    max_attempts: 3", `    backoff: ${backoff}`],
    mainJs: resumed
      ? `if (process.env.SWIZZLE_EXECUTION === "1") {
          console.log(JSON.stringify({ $swizzle: { suspend: { reason: "sleep", stepKey: "nap", until: "2000-01-01T00:00:00.000Z" } } }));
        } else { ${fails} }`
      : fails,
  });
  await platform.deployAutomationToPlatform({ environment: "local", automationDirectory });
  await platform.enqueuePlatformRun({
    environment: "local",
    automationName: "retry-recovery",
    runId: RUN_ID,
  });
  const execution = await createTestExecution({ queue, store, profiles: ["host-default"] });
  /** Runs the run's next attempt as a worker would, and returns the run after it. */
  const attempt = async (onStderrChunk?: () => void) => {
    await execution.run(RUN_ID, {
      environment: process.env,
      ...(onStderrChunk !== undefined ? { publish: async () => onStderrChunk() } : {}),
    });
    return await platform.getPlatformRun(RUN_ID);
  };
  if (resumed) {
    expect((await attempt()).status).toBe("waiting");
    await platform.resumeDueWaitingRuns({ environment: "local" });
  }
  return { attempt, jobs, platform, store };
}

describe("retry recovery", () => {
  // The dashboard reads "Running, attempt 2" from attemptsMade while the attempt runs.
  it.each([
    { resumed: false, attemptsMade: [1, 2] },
    { resumed: true, attemptsMade: [1, 2] },
  ])(
    "counts the running attempt in its segment's attemptsMade (resumed=$resumed)",
    async ({ resumed, attemptsMade }) => {
      const { attempt, store } = await retryingRun("fixed", resumed);
      const seen: number[] = [];
      for (const spent of [1, 2]) {
        const reads: Promise<void>[] = [];
        await attempt(() => {
          reads.push(
            store.getRun(RUN_ID).then((run) => {
              seen[spent - 1] = run?.attemptsMade ?? -1;
            }),
          );
        });
        await Promise.all(reads);
      }
      expect(seen).toEqual(attemptsMade);
    },
  );

  it.each([
    { backoff: "fixed", resumed: false },
    { backoff: "exponential", resumed: false },
    { backoff: "fixed", resumed: true },
    { backoff: "exponential", resumed: true },
  ])(
    "recovers $backoff retries (resumed=$resumed) with the remaining delay and segment budget",
    async ({ backoff, resumed }) => {
      const { attempt, jobs, platform } = await retryingRun(backoff, resumed);
      const now = vi.spyOn(Date, "now");
      const jobId = resumed ? `${RUN_ID}--s1` : RUN_ID;
      for (let spent = 1; spent <= 3; spent++) {
        const run = await attempt();
        if (spent === 3) {
          expect(run).toMatchObject({
            status: "dead-lettered",
            attemptsMade: spent,
          });
          break;
        }
        expect(run).toMatchObject({ status: "queued", attemptsMade: spent });
        const finishedAt = run.executions.at(-1)?.finishedAt;
        if (!finishedAt) throw new Error("retry attempt must have a finish timestamp");
        now.mockReturnValue(Date.parse(finishedAt) + 250);
        jobs.clear(); // Lose the delayed job, including on a second recovery of this segment.
        expect(await platform.reconcileQueuedRuns({ environment: "local" })).toMatchObject({
          requeuedRunIds: [RUN_ID],
        });
        const retryDelay = backoff === "fixed" ? 1000 : 1000 * 2 ** (spent - 1);
        expect(jobs.get(jobId)).toMatchObject({
          attempts: 3 - spent,
          backoff: {
            type: backoff,
            delay: backoff === "fixed" ? 1000 : 1000 * 2 ** spent,
          },
          delay: retryDelay - 250,
        });
        expect(await platform.reconcileQueuedRuns({ environment: "local" })).toMatchObject({
          skippedExistingJobIds: [jobId],
        });
        jobs.clear();
        now.mockReturnValue(Date.parse(finishedAt) + retryDelay + 1);
        await platform.reconcileQueuedRuns({ environment: "local" });
        expect(jobs.get(jobId)).toMatchObject({ delay: 0, attempts: 3 - spent });
      }
      expect(
        (await platform.getPlatformRun(RUN_ID)).executions.map((execution) => execution.status),
      ).toEqual(
        resumed
          ? ["suspended", "retrying", "retrying", "dead-lettered"]
          : ["retrying", "retrying", "dead-lettered"],
      );
    },
  );
});
