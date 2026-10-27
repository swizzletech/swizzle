import { collectDefaultMetrics, Gauge, Registry } from "@prometheus-io/client";

export interface MetricsRegistryHandle {
  readonly contentType: string;
  metrics(): Promise<string>;
  readonly registry: Registry;
  setQueueDepth(queueName: string, counts: QueueCountsSnapshot): void;
}

interface QueueCountsSnapshot {
  readonly active: number;
  readonly completed: number;
  readonly delayed: number;
  readonly failed: number;
  readonly waiting: number;
}

export function createMetricsRegistry(): MetricsRegistryHandle {
  const registry = new Registry();
  registry.setDefaultLabels({ app: "swizzle-api" });
  collectDefaultMetrics({ register: registry });

  const queueDepth = new Gauge({
    help: "Current BullMQ queue depth by state",
    labelNames: ["queue", "state"],
    name: "swizzle_queue_depth",
    registers: [registry],
  });

  return {
    contentType: registry.contentType,
    metrics: () => registry.metrics(),
    registry,
    setQueueDepth(queueName, counts) {
      queueDepth.set({ queue: queueName, state: "active" }, counts.active);
      queueDepth.set({ queue: queueName, state: "waiting" }, counts.waiting);
      queueDepth.set({ queue: queueName, state: "completed" }, counts.completed);
      queueDepth.set({ queue: queueName, state: "failed" }, counts.failed);
      queueDepth.set({ queue: queueName, state: "delayed" }, counts.delayed);
    },
  };
}
