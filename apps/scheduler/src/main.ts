import { createHash } from "node:crypto";
import os from "node:os";
import {
  bootService,
  configureOutboundHttpProxy,
  createLogger,
  resolveServiceInstanceId,
  shutdownTracing,
} from "@swizzle/core";
import {
  createDashboardStore,
  createPostgresEnvironmentStore,
  createServiceHeartbeatReporter,
  type ServiceHeartbeatReporter,
} from "@swizzle/db/postgres";

import { startSchedulerHealthServer } from "./health-server.js";
import { createSchedulerService } from "./scheduler.js";

const logger = createLogger("swizzle-scheduler");
const instanceId = resolveServiceInstanceId({ service: "scheduler" });
await bootService(logger, configureOutboundHttpProxy);
const environmentStore = createPostgresEnvironmentStore();
const heartbeatStore = createDashboardStore();
const heartbeats = new Map<string, ServiceHeartbeatReporter>();

async function listEnvironments(): Promise<readonly string[]> {
  const names = [
    ...new Set([
      "staging",
      "production",
      ...(await environmentStore.listEnvironments()).map(({ name }) => name),
    ]),
  ];
  for (const environment of names) {
    if (heartbeats.has(environment)) continue;
    const heartbeat = createServiceHeartbeatReporter({
      environment,
      host: os.hostname(),
      // Heartbeat rows are keyed by service and instance, so each namespace needs its own key.
      instanceId: createHash("sha256").update(`${instanceId}:${environment}`).digest("hex"),
      logger,
      metadata: { schedulerInstanceId: instanceId },
      pid: process.pid,
      service: "scheduler",
      store: heartbeatStore,
    });
    heartbeats.set(environment, heartbeat);
    heartbeat.start();
  }
  return names;
}

async function main() {
  const scheduler = await createSchedulerService({
    enableLeaderLock: (process.env.SWIZZLE_SCHEDULER_LEADER_LOCK ?? "on") !== "off",
    listEnvironments,
    instanceId,
    intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 15_000),
    logger,
    maintenanceIntervalMs: Number(process.env.SCHEDULER_MAINTENANCE_INTERVAL_MS ?? 60_000),
    resumeWaitingIntervalMs: Number(process.env.SCHEDULER_RESUME_WAITING_INTERVAL_MS ?? 5_000),
  });

  await listEnvironments();
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
      ...[...heartbeats.values()].map((heartbeat) => heartbeat.close()),
      scheduler.close(),
      healthServer.close(),
      shutdownTracing(),
    ]).then(async () => {
      await environmentStore.close();
      await heartbeatStore.close();
    });
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
