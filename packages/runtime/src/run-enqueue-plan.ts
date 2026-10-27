import type { StoredRun } from "@swizzle/db";
import { type RunQueueProducer, toBullMqBackoff } from "./run-queue.js";

// BullMQ custom job IDs cannot contain a colon.
const RESUME_JOB_ID_MARKER = "--s";

type RunEnqueuePlan = Omit<Parameters<RunQueueProducer["enqueue"]>[0], "queueName" | "runId">;

/** Derives the job's retry budget and delay from the run's durable state. */
export function planRunEnqueue(run: StoredRun, now: number): RunEnqueuePlan {
  const latest = run.executions.at(-1);
  // The attempts this segment spent. A resume resets it, and a delivery lost before start leaves
  // it as it was.
  const spent = run.attemptsMade;
  const backoff = toBullMqBackoff(run.config.runtime.retry.backoff, spent);
  const retryDelay =
    run.config.runtime.retry.backoff === "exponential" && spent > 0
      ? backoff.delay / 2
      : backoff.delay;
  return {
    attempts: run.attemptsMax - spent,
    backoff,
    delay:
      latest?.status === "retrying" && latest.finishedAt !== null
        ? Math.max(0, Date.parse(latest.finishedAt) + retryDelay - now)
        : 0,
    jobId:
      run.resumeCount > 0
        ? `${run.runId}${RESUME_JOB_ID_MARKER}${run.resumeCount}`
        : run.queueJobId,
  };
}
