import os from "node:os";
import {
  bootService,
  configureOutboundHttpProxy,
  createLogger,
  resolveServiceInstanceId,
  shutdownTracing,
} from "@swizzle/core";
import { createServiceHeartbeatReporter, readConfiguredEnvironment } from "@swizzle/db/postgres";

import { startSchedulerHealthServer } from "./health-server.js";
import { createSchedulerService } from "./scheduler.js";

const logger = createLogger("swizzle-scheduler");
const instanceId = resolveServiceInstanceId({ service: "scheduler" });
const environmentName = await bootService(logger, async () => {
  await configureOutboundHttpProxy();
  return readConfiguredEnvironment();
});
const heartbeat = createServiceHeartbeatReporter({
  environment: environmentName,
  host: os.hostname(),
  instanceId,
  logger,
  metadata: {
    intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 15_000),
    maintenanceIntervalMs: Number(process.env.SCHEDULER_MAINTENANCE_INTERVAL_MS ?? 60_000),
    resumeWaitingIntervalMs: Number(process.env.SCHEDULER_RESUME_WAITING_INTERVAL_MS ?? 5_000),
  },
  pid: process.pid,
  service: "scheduler",
});

async function main() {
  const scheduler = await createSchedulerService({
    enableLeaderLock: (process.env.SWIZZLE_SCHEDULER_LEADER_LOCK ?? "on") !== "off",
    environmentName,
    instanceId,
    intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 15_000),
    logger,
    maintenanceIntervalMs: Number(process.env.SCHEDULER_MAINTENANCE_INTERVAL_MS ?? 60_000),
    resumeWaitingIntervalMs: Number(process.env.SCHEDULER_RESUME_WAITING_INTERVAL_MS ?? 5_000),
  });

  heartbeat.start();
  scheduler.start();
  const healthServer = await startSchedulerHealthServer({
    checkReady: async () => true,
    logger,
    port: Number(process.env.SCHEDULER_HEALTH_PORT ?? 19829),
  });
  logger.info("Scheduler service started.");

  const shutdownTimeoutMs = Number(process.env.SWIZZLE_SHUTDOWN_TIMEOUT_MS ?? 30_000);
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, shutdownTimeoutMs }, "Shutting down scheduler service.");

    const drain = Promise.all([
      heartbeat.close(),
      scheduler.close(),
      healthServer.close(),
      shutdownTracing(),
    ]);
    const timer = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), shutdownTimeoutMs).unref(),
    );

    const result = await Promise.race([drain.then(() => "drained" as const), timer]);
    if (result === "timeout") {
      logger.error({ shutdownTimeoutMs }, "Scheduler drain timed out — forcing exit.");
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  logger.error(error, "Scheduler service crashed.");
  process.exitCode = 1;
});
