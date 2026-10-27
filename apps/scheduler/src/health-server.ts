import Fastify from "fastify";
import type { Logger } from "pino";

export interface SchedulerHealthServerOptions {
  readonly checkReady: () => Promise<boolean>;
  readonly logger?: Logger;
  readonly port?: number;
}

export interface SchedulerHealthServerHandle {
  close(): Promise<void>;
}

export async function startSchedulerHealthServer(
  options: SchedulerHealthServerOptions,
): Promise<SchedulerHealthServerHandle> {
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger } : {}),
  });

  app.get("/health", async () => ({ service: "scheduler", status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      const ready = await options.checkReady();
      if (!ready) reply.status(503);
      return { service: "scheduler", status: ready ? "ready" : "not-ready" };
    } catch (error) {
      reply.status(503);
      return {
        error: error instanceof Error ? error.message : String(error),
        service: "scheduler",
        status: "not-ready",
      };
    }
  });

  // Only the container healthcheck on 127.0.0.1 asks, so nothing else may reach it.
  await app.listen({ host: "127.0.0.1", port: options.port ?? 19829 });
  return { close: async () => await app.close() };
}
