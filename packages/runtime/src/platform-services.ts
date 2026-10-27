import { checkDatabaseReadiness, listRegisteredReadinessWorkers } from "./deployment-admin.js";
import { resolveMaintenanceRetentionPolicy, runMaintenanceCycle } from "./maintenance.js";
import { createPlatformServiceFacade } from "./platform-service-facade.js";
import type { CreatePlatformServicesOptions, PlatformServices } from "./platform-types.js";
import {
  openControlPlaneStore,
  openDashboardStore,
  openWorkerRegistry,
} from "./postgres-stores.js";
import { checkQueueReadiness, createRunQueueProducer, DEFAULT_VALKEY_URL } from "./run-queue.js";
import { checkConfiguredArtifactStorageReadiness } from "./storage.js";

export async function createPlatformServices(
  options: CreatePlatformServicesOptions = {},
): Promise<PlatformServices> {
  const store = options.store ?? (await openControlPlaneStore());
  const ownStore = options.store === undefined;
  const dashboardStore = options.dashboardStore ?? (await openDashboardStore());
  const ownDashboardStore = options.dashboardStore === undefined;
  const registry = options.workerRegistry ?? (await openWorkerRegistry());
  const valkeyUrl = options.valkeyUrl ?? DEFAULT_VALKEY_URL;
  const queue = createRunQueueProducer(valkeyUrl);
  return createPlatformServiceFacade({
    ...(options.artifactsDirectory !== undefined
      ? { artifactsDirectory: options.artifactsDirectory }
      : {}),
    checkReadiness: async () => {
      const [artifactStorageResult, dbResult, queueResult] = await Promise.all([
        checkConfiguredArtifactStorageReadiness({
          ...(options.artifactsDirectory !== undefined
            ? { artifactsDirectory: options.artifactsDirectory }
            : {}),
        }),
        checkDatabaseReadiness(store),
        checkQueueReadiness(valkeyUrl),
      ]);
      return {
        checks: {
          artifactStorage: artifactStorageResult,
          database: dbResult,
          queue: queueResult,
        },
        ok: artifactStorageResult.ok && dbResult.ok && queueResult.ok,
      };
    },
    close: async () => {
      await queue.close();
      if (options.workerRegistry === undefined) await registry.close();
      if (ownStore) {
        await store.close();
      }
      if (ownDashboardStore) {
        await dashboardStore.close();
      }
    },
    listReadinessWorkers: ({ environment, projectId }) =>
      listRegisteredReadinessWorkers(registry, environment, projectId),
    placeRun: (run) =>
      registry.placement({
        runId: run.runId,
        projectId: run.projectId,
        environment: run.environment,
        profile: run.config.runtime.profile,
        services: run.config.runtime.permissions.services,
        queueTimeout: run.config.runtime.queue_timeout,
      }),
    queue,
    runMaintenance: async (maintenanceOptions) =>
      await runMaintenanceCycle({
        environment: maintenanceOptions.environment,
        ...(maintenanceOptions.now !== undefined ? { now: maintenanceOptions.now } : {}),
        retention: maintenanceOptions.retention ?? resolveMaintenanceRetentionPolicy(),
        store,
        valkeyUrl,
      }),
    store,
  });
}
