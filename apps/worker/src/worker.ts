import { DEFAULT_WORKER_CONCURRENCY } from "@swizzle/core";
import {
  type PlatformLogger,
  type PlatformWorkerController,
  startPlatformWorkerService,
} from "@swizzle/runtime/platform";
import pino, { type Logger } from "pino";

export interface WorkerServiceOptions {
  readonly allowLocalHttp?: boolean;
  readonly apiUrl: string;
  readonly credential: Parameters<typeof startPlatformWorkerService>[0]["credential"];
  readonly capabilities: Parameters<typeof startPlatformWorkerService>[0]["capabilities"];
  readonly concurrency?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly logger?: PlatformLogger;
}

export async function startWorkerService(
  options: WorkerServiceOptions,
): Promise<PlatformWorkerController> {
  const logger = options.logger ?? createLogger();

  // The registry owns this worker's groups and grants; the API applies them to every request.
  logger.info(
    { concurrency: options.concurrency ?? DEFAULT_WORKER_CONCURRENCY },
    "Worker service booting.",
  );

  return await startPlatformWorkerService({
    apiUrl: options.apiUrl,
    ...(options.allowLocalHttp === undefined ? {} : { allowLocalHttp: options.allowLocalHttp }),
    credential: options.credential,
    capabilities: options.capabilities,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    logger,
  });
}

function createLogger(): Logger {
  return pino({
    name: "swizzle-worker",
    level: process.env.LOG_LEVEL ?? "info",
  });
}
