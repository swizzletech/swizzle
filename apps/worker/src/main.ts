import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  bootService,
  configureOutboundHttpProxy,
  createLogger,
  readWorkerConcurrency,
  shutdownTracing,
} from "@swizzle/core";
import { collectWorkerCapabilities, isDockerAvailable, readRunnerTools } from "@swizzle/runtime";

import { startWorkerHealthServer } from "./health-server.js";
import { assertWorkerSecurityConfiguration } from "./security-config.js";
import { startWorkerService } from "./worker.js";

const concurrency = readWorkerConcurrency(process.env.WORKER_CONCURRENCY);
const logger = createLogger("swizzle-worker");
await bootService(logger, async () => {
  if (process.env.SWIZZLE_WORKER_LOCAL_HTTP !== "true") await configureOutboundHttpProxy();
  await assertWorkerSecurityConfiguration();
});
// A sandboxed run calls only what the runner image has. A host worker, for local development only,
// reports the runtimes it measures.
const sandboxed = process.env.SWIZZLE_REQUIRE_SANDBOX?.trim().toLowerCase() === "true";
const capabilities = await collectWorkerCapabilities(sandboxed ? await readRunnerTools() : []);
// Remote credentials live in a private file. The local identity is configured by the stack.
const credential =
  process.env.SWIZZLE_WORKER_CREDENTIAL_FILE === undefined
    ? process.env
    : parseEnv(await readFile(process.env.SWIZZLE_WORKER_CREDENTIAL_FILE, "utf8"));
const apiUrl = credential.SWIZZLE_WORKER_API_URL;
const token = credential.SWIZZLE_WORKER_TOKEN;
if (!apiUrl || !token)
  throw new Error(
    "Set SWIZZLE_WORKER_API_URL and SWIZZLE_WORKER_TOKEN, or SWIZZLE_WORKER_CREDENTIAL_FILE to the file swizzle worker enroll wrote.",
  );
if (
  process.env.SWIZZLE_WORKER_CREDENTIAL_FILE === undefined &&
  process.env.NODE_ENV === "production" &&
  process.env.SWIZZLE_WORKER_LOCAL_HTTP !== "true"
)
  throw new Error(
    "Remote workers require SWIZZLE_WORKER_CREDENTIAL_FILE so token renewal survives restarts.",
  );
const controller = await startWorkerService({
  apiUrl,
  allowLocalHttp: process.env.SWIZZLE_WORKER_LOCAL_HTTP === "true",
  credential:
    process.env.SWIZZLE_WORKER_CREDENTIAL_FILE === undefined
      ? { kind: "configured", token }
      : { kind: "file", path: process.env.SWIZZLE_WORKER_CREDENTIAL_FILE },
  capabilities,
  concurrency,
  logger,
});

const healthServer = await startWorkerHealthServer({
  concurrency,
  checkReady: async () =>
    process.env.SWIZZLE_REQUIRE_SANDBOX !== "true" || (await isDockerAvailable()),
  logger,
  port: Number(process.env.WORKER_HEALTH_PORT ?? 19828),
});

const shutdownTimeoutMs = Number(process.env.SWIZZLE_SHUTDOWN_TIMEOUT_MS ?? 30_000);
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, shutdownTimeoutMs }, "Draining worker before exit.");

  const drain = Promise.all([controller.close(), healthServer.close(), shutdownTracing()]);
  const timer = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), shutdownTimeoutMs).unref(),
  );

  const result = await Promise.race([drain.then(() => "drained" as const), timer]);
  if (result === "timeout") {
    logger.error({ shutdownTimeoutMs }, "Worker drain timed out — forcing exit.");
    process.exit(1);
  }
  logger.info("Worker drained cleanly.");
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
