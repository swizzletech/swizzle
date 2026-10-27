import { createDashboardStore } from "./dashboard.js";
import type { DashboardStore, ServiceHeartbeatRecord } from "./dashboard-types.js";

const DEFAULT_INTERVAL_MS = 10_000;

export interface ServiceHeartbeatLogger {
  error(error: unknown, message: string): void;
}

export interface CreateServiceHeartbeatReporterOptions {
  readonly environment: string;
  readonly host?: string | null;
  readonly instanceId: string;
  readonly intervalMs?: number;
  readonly logger?: ServiceHeartbeatLogger;
  readonly metadata?: Record<string, unknown>;
  readonly pid?: number | null;
  readonly service: string;
  readonly store?: DashboardStore;
}

export interface ServiceHeartbeatReporter {
  beat(metadata?: Record<string, unknown>): Promise<ServiceHeartbeatRecord>;
  close(): Promise<void>;
  start(): void;
}

export function createServiceHeartbeatReporter(
  options: CreateServiceHeartbeatReporterOptions,
): ServiceHeartbeatReporter {
  const store = options.store ?? createDashboardStore();
  const ownStore = options.store === undefined;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let intervalHandle: NodeJS.Timeout | null = null;

  const beat = async (metadata?: Record<string, unknown>) => {
    return await store.upsertServiceHeartbeat({
      environment: options.environment,
      ...(options.host !== undefined ? { host: options.host } : {}),
      instanceId: options.instanceId,
      ...(metadata !== undefined || options.metadata !== undefined
        ? { metadata: metadata ?? options.metadata }
        : {}),
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
      service: options.service,
    });
  };

  return {
    beat,

    async close() {
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }

      if (ownStore) {
        await store.close();
      }
    },

    start() {
      if (intervalHandle !== null) {
        return;
      }

      void beat().catch((error) => {
        options.logger?.error(error, `Initial ${options.service} heartbeat failed.`);
      });

      intervalHandle = setInterval(() => {
        void beat().catch((error) => {
          options.logger?.error(error, `${options.service} heartbeat failed.`);
        });
      }, intervalMs);
    },
  };
}
