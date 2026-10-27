import os from "node:os";

export interface ResolveServiceInstanceIdOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly hostname?: string;
  readonly service: string;
}

/**
 * Resolves a stable instance ID for a long-running service (worker, scheduler, …).
 *
 * Precedence:
 *   1. `SWIZZLE_INSTANCE_ID` env var — operator-provided, used verbatim.
 *   2. `${service}-${hostname}` fallback — stable per container (no PID), so a
 *      process restart within the same container reuses the same row.
 *
 * The row's primary key in `dashboard_services` is `(service, instanceId)`; a
 * stable ID means heartbeats upsert in place instead of accumulating a new row
 * on every container recreate.
 */
export function resolveServiceInstanceId(options: ResolveServiceInstanceIdOptions): string {
  const env = options.env ?? process.env;
  const override = env.SWIZZLE_INSTANCE_ID?.trim();
  if (override) {
    return override;
  }

  const hostname = options.hostname ?? os.hostname();
  return `${options.service}-${hostname}`;
}
