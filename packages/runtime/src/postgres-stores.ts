// Opens the Postgres stores the runtime's services use. `@swizzle/db/postgres` loads drizzle and pg,
// so the runtime imports it here, when a service opens a store, instead of at module load: the CLI
// and tests that use only pure runtime helpers need no database client.
import type { ControlPlaneStore, DashboardStore } from "@swizzle/db";

export async function openControlPlaneStore(): Promise<ControlPlaneStore> {
  const { createPostgresControlPlaneStore } = await import("@swizzle/db/postgres");
  return createPostgresControlPlaneStore();
}

export async function openDashboardStore(): Promise<DashboardStore> {
  const { createDashboardStore } = await import("@swizzle/db/postgres");
  return createDashboardStore();
}

export async function openWorkerRegistry() {
  const { createPostgresWorkerRegistry } = await import("@swizzle/db/postgres");
  return createPostgresWorkerRegistry();
}

export async function openRunImageRetentionStore() {
  const { createRunImageRetentionStore } = await import("@swizzle/db/postgres");
  return createRunImageRetentionStore();
}
