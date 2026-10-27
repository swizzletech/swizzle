import { Redis } from "ioredis";

interface RunLogChunkEvent {
  readonly chunk: string;
  /** The execution that printed the chunk. */
  readonly executionNumber: number;
  readonly runId: string;
  readonly stream: "stderr" | "stdout";
  readonly timestamp: string;
  readonly type: "chunk";
}

interface RunLogStatusEvent {
  /** The execution whose end moved the run; null when no execution did. */
  readonly executionNumber: number | null;
  readonly runId: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly timestamp: string;
  readonly type: "status";
}

/** A step of the run started or finished, so the dashboard's track moves without polling. */
interface RunLogStepEvent {
  /** The retry attempt the reporting execution spends. */
  readonly attempt: number;
  readonly executionNumber: number;
  readonly key: string;
  readonly runId: string;
  readonly status: "started" | "done";
  readonly timestamp: string;
  readonly type: "step";
}

export type RunLogEvent = RunLogChunkEvent | RunLogStatusEvent | RunLogStepEvent;

export interface RunLogPublisher {
  publish(event: RunLogEvent): Promise<void>;
  close(): Promise<void>;
}

const CHANNEL_PREFIX = "swizzle:run-logs:";

function channelFor(runId: string): string {
  return `${CHANNEL_PREFIX}${runId}`;
}

export function createRunLogPublisher(valkeyUrl: string): RunLogPublisher {
  const redis = new Redis(valkeyUrl, { maxRetriesPerRequest: null });
  return {
    async publish(event) {
      await redis.publish(channelFor(event.runId), JSON.stringify(event));
    },
    async close() {
      await redis.quit();
    },
  };
}

/**
 * Delivers the run's log events to `onEvent` until `signal` aborts. Resolves once the subscription
 * stands; an abort before that rejects it, so a caller never waits on a Valkey that is down after
 * its client left.
 */
export async function subscribeRunLogEvents(input: {
  readonly valkeyUrl: string;
  readonly runId: string;
  readonly onEvent: (event: RunLogEvent) => void;
  readonly onError?: (error: Error) => void;
  readonly signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  const redis = new Redis(input.valkeyUrl, { maxRetriesPerRequest: null });
  const channel = channelFor(input.runId);
  // ioredis leaves a command queued for a connection that never comes pending after disconnect().
  const left = new Promise<never>((_, reject) => {
    input.signal.addEventListener(
      "abort",
      () => {
        redis.disconnect();
        reject(input.signal.reason);
      },
      { once: true },
    );
  });
  left.catch(() => {});

  redis.on("message", (receivedChannel, payload) => {
    if (receivedChannel !== channel) return;
    try {
      const parsed = JSON.parse(payload) as RunLogEvent;
      input.onEvent(parsed);
    } catch (error) {
      input.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });

  if (input.onError) {
    redis.on("error", input.onError);
  }

  await Promise.race([redis.subscribe(channel), left]);
}
