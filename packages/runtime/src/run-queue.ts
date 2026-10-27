import { context as otContext, propagation } from "@opentelemetry/api";
import type { JobsOptions } from "bullmq";
import { Queue } from "bullmq";

import { getErrorMessage } from "./errors.js";

const DEFAULT_RETRY_BACKOFF_DELAY_MS = 1_000;
const DEFAULT_RUN_JOB_NAME = "execute-platform-run";
const CHECK_JOB_NAME = "execute-api-check";

export const DEFAULT_VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";

interface RunQueueJobData {
  readonly kind: "run";
  readonly runId: string;
  readonly traceContext?: Record<string, string>;
}

/** An API check due at `dueAt`. Its job ID starts with `CHECK_JOB_ID_PREFIX` and names no run. */
interface CheckQueueJobData {
  readonly kind: "check";
  readonly checkId: string;
  readonly dueAt: string;
}

export type QueueJobData = RunQueueJobData | CheckQueueJobData;

const CHECK_JOB_ID_PREFIX = "check-";

/** BullMQ job IDs cannot hold ":", so the due time goes in as epoch milliseconds. */
function checkJobId(checkId: string, dueAt: string): string {
  return `${CHECK_JOB_ID_PREFIX}${checkId}-${Date.parse(dueAt)}`;
}

export interface RunQueueProducer {
  close(): Promise<void>;
  /** Adds a check job, once per check and due time; a job that already exists stays. */
  enqueueCheck(input: {
    readonly checkId: string;
    readonly dueAt: string;
    readonly queueName: string;
  }): Promise<void>;
  enqueue(input: {
    readonly attempts: number;
    readonly backoff: JobsOptions["backoff"];
    readonly delay?: number;
    readonly jobId: string;
    readonly queueName: string;
    readonly runId: string;
  }): Promise<void>;
  hasJob(input: { readonly jobId: string; readonly queueName: string }): Promise<boolean>;
}

export function toBullMqBackoff(backoff: "fixed" | "exponential", consumed = 0) {
  return {
    delay: DEFAULT_RETRY_BACKOFF_DELAY_MS * (backoff === "exponential" ? 2 ** consumed : 1),
    type: backoff,
  };
}

export function createRunQueueProducer(valkeyUrl: string): RunQueueProducer {
  const queues = new Map<string, Queue>();

  const getQueue = (queueName: string): Queue => {
    const existing = queues.get(queueName);
    if (existing) {
      return existing;
    }

    const queue = new Queue(queueName, {
      connection: createBullMqConnection(valkeyUrl),
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    queues.set(queueName, queue);
    return queue;
  };

  return {
    close: async () => {
      await Promise.all(Array.from(queues.values()).map(async (queue) => await queue.close()));
    },
    enqueue: async (input) => {
      const carrier: Record<string, string> = {};
      propagation.inject(otContext.active(), carrier);
      await getQueue(input.queueName).add(
        DEFAULT_RUN_JOB_NAME,
        {
          kind: "run",
          runId: input.runId,
          traceContext: carrier,
        } satisfies RunQueueJobData,
        {
          attempts: input.attempts,
          ...(input.delay !== undefined ? { delay: input.delay } : {}),
          ...(input.backoff !== undefined ? { backoff: input.backoff } : {}),
          jobId: input.jobId,
        },
      );
    },
    enqueueCheck: async (input) => {
      // One attempt: the worker records every outcome itself. A job that is lost or stalls is
      // removed, so the next scheduler tick finds the check still due and adds it again.
      await getQueue(input.queueName).add(
        CHECK_JOB_NAME,
        { checkId: input.checkId, dueAt: input.dueAt, kind: "check" } satisfies CheckQueueJobData,
        {
          attempts: 1,
          jobId: checkJobId(input.checkId, input.dueAt),
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    },
    hasJob: async (input) => {
      // BullMQ's getJob resolves to undefined (not null) for missing jobs; a
      // null-only check makes hasJob always true and disables run recovery.
      const job = await getQueue(input.queueName).getJob(input.jobId);
      return job !== undefined && job !== null;
    },
  };
}

export async function checkQueueReadiness(
  valkeyUrl: string,
): Promise<{ readonly error?: string; readonly ok: boolean }> {
  const { Redis } = await import("ioredis");
  const client = new Redis(valkeyUrl, {
    connectTimeout: 3000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await client.connect();
    const reply = await client.ping();
    return { ok: reply === "PONG" };
  } catch (error) {
    return { error: getErrorMessage(error), ok: false };
  } finally {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}

export function createBullMqConnection(valkeyUrl: string, forWorker = false) {
  const url = new URL(valkeyUrl);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;

  return {
    ...(database === undefined || Number.isNaN(database) ? {} : { db: database }),
    host: url.hostname,
    ...(url.password ? { password: url.password } : {}),
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: url.username } : {}),
    ...(forWorker ? { maxRetriesPerRequest: null } : {}),
  };
}
