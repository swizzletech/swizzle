import path from "node:path";
import { AUTOMATION_RUNTIME_PROFILE_DEFAULT } from "@swizzle/config";
import type { AuditStore, ControlPlaneStore, StoredAutomationCheck } from "@swizzle/db";
import { createPostgresAuditStore, createPostgresControlPlaneStore } from "@swizzle/db/postgres";
import {
  resolveMaintenanceRetentionPolicy,
  runMaintenanceCycle,
} from "../packages/runtime/src/maintenance.js";
import { createPlatformServiceFacade } from "../packages/runtime/src/platform-service-facade.js";
import type {
  CreatePlatformServicesOptions,
  PlatformRunRecord,
  PlatformServices,
} from "../packages/runtime/src/platform-types.js";
import { checkAndRecordRunRateLimits } from "../packages/runtime/src/rate-limit-enforcement.js";
import { getRunOrThrow } from "../packages/runtime/src/run-lifecycle.js";
import type { RunQueueProducer } from "../packages/runtime/src/run-queue.js";
import {
  createQueueNameForProfile,
  thisMachine,
} from "../packages/runtime/src/runtime-requirements.js";
import { checkConfiguredArtifactStorageReadiness } from "../packages/runtime/src/storage.js";
import { createTestExecution } from "./execution.js";
import { testDatabase } from "./postgres.js";
import { temporaryDirectory } from "./support.js";

type ProcessNextPlatformRunOptions = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly automationName?: string;
  readonly rateLimiter?: import("../packages/runtime/src/rate-limiter.js").RateLimiter;
  readonly onStderrChunk?: (chunk: string, run: import("@swizzle/db").StoredRun) => void;
};

export interface TestPlatform extends PlatformServices {
  readonly auditStore: AuditStore;
  readonly store: ControlPlaneStore;
  processNextPlatformRun(
    options?: ProcessNextPlatformRunOptions,
  ): Promise<PlatformRunRecord | null>;
  processPlatformCheck(
    checkId: string,
    dueAt: string,
    options?: { readonly environment?: NodeJS.ProcessEnv },
  ): Promise<StoredAutomationCheck | null>;
}
export async function testPlatform(
  options: Pick<CreatePlatformServicesOptions, "artifactsDirectory"> & {
    readonly client?: import("@swizzle/db/postgres").DatabaseClient;
    readonly profiles?: readonly string[];
    readonly auditStore?: import("@swizzle/db").AuditStore;
    /** The workers that serve every project; by default this process, as it runs every run. */
    readonly readinessWorkers?: readonly import("@swizzle/runtime").ReadinessWorker[];
  } = {},
): Promise<TestPlatform> {
  const client = options.client ?? testDatabase();
  const store = createPostgresControlPlaneStore({ client });
  const auditStore = options.auditStore ?? createPostgresAuditStore({ client });
  const artifactsDirectory =
    options.artifactsDirectory ??
    path.join(await temporaryDirectory("swizzle-platform-"), "artifacts");
  const queuedRuns: Array<{ jobId: string; queueName: string; runId: string }> = [];
  const queue: RunQueueProducer = {
    close: async () => {},
    // The test platform has no scheduler loop; tests call processPlatformCheck directly.
    enqueueCheck: async () => {},
    enqueue: async (input) => {
      queuedRuns.push({ jobId: input.jobId, queueName: input.queueName, runId: input.runId });
    },
    hasJob: async (input) =>
      queuedRuns.some(
        (entry) => entry.jobId === input.jobId && entry.queueName === input.queueName,
      ),
  };
  const profiles = options.profiles ?? [AUTOMATION_RUNTIME_PROFILE_DEFAULT];
  const execution = await createTestExecution({ queue, store, client, profiles });

  const services = createPlatformServiceFacade({
    ...(artifactsDirectory !== undefined ? { artifactsDirectory: artifactsDirectory } : {}),
    checkReadiness: async () => {
      const artifactStorageResult = artifactsDirectory
        ? await checkConfiguredArtifactStorageReadiness({
            artifactsDirectory: artifactsDirectory,
          })
        : { backend: "local" as const, ok: true, target: "test" };
      return {
        checks: {
          artifactStorage: artifactStorageResult,
          database: { ok: true },
          queue: { ok: true },
        },
        ok: artifactStorageResult.ok,
      };
    },
    close: async () => {
      await queue.close();
    },
    onRunCancelled: (runId) => {
      const queuedIndex = queuedRuns.findIndex((entry) => entry.runId === runId);
      if (queuedIndex !== -1) {
        queuedRuns.splice(queuedIndex, 1);
      }
    },
    // The test platform runs every run in this process, so it is its own only worker.
    listReadinessWorkers: async ({ config }) =>
      options.readinessWorkers ?? [await thisMachine(config.runtime, `test-worker-${process.pid}`)],
    placeRun: async () => null,
    queue,
    runMaintenance: async (maintenanceOptions) =>
      await runMaintenanceCycle({
        environment: maintenanceOptions.environment,
        ...(maintenanceOptions.now !== undefined ? { now: maintenanceOptions.now } : {}),
        queueCounts: {
          active: 0,
          completed: 0,
          delayed: 0,
          failed: 0,
          waiting: queuedRuns.length,
        },
        retention: maintenanceOptions.retention ?? resolveMaintenanceRetentionPolicy(),
        store,
      }),
    store,
  });

  async function findQueuedRun(automationName: string | undefined, allowedQueues: Set<string>) {
    for (const [index, entry] of queuedRuns.entries()) {
      if (!allowedQueues.has(entry.queueName)) continue;
      if (
        automationName === undefined ||
        (await getRunOrThrow(store, entry.runId)).automationName === automationName
      )
        return index;
    }
    return -1;
  }

  return {
    ...services,
    auditStore,
    store,
    processNextPlatformRun: async (processOptions = {}) => {
      const allowedQueues = new Set(profiles.map((profile) => createQueueNameForProfile(profile)));
      const queueEntryIndex = await findQueuedRun(processOptions.automationName, allowedQueues);
      if (queueEntryIndex === -1) {
        return null;
      }

      const [queueEntry] = queuedRuns.splice(queueEntryIndex, 1);
      if (queueEntry === undefined) {
        return null;
      }

      const run = await getRunOrThrow(store, queueEntry.runId);
      const { rateLimiter, onStderrChunk } = processOptions;
      const claimed = await execution.run(run.runId, {
        // Rate admission precedes claiming: a blocked run stays queued without spending an attempt.
        ...(rateLimiter !== undefined
          ? {
              admit: async () =>
                (
                  await checkAndRecordRunRateLimits({
                    rateLimiter,
                    rateLimits: run.config.runtime.rate_limits,
                  })
                ).allowed,
            }
          : {}),
        environment: processOptions.environment ?? process.env,
        ...(onStderrChunk !== undefined
          ? {
              publish: async (event) => {
                if (event.type === "chunk" && event.stream === "stderr")
                  onStderrChunk(event.chunk, run);
              },
            }
          : {}),
      });
      if (!claimed) {
        if (run.status === "queued") queuedRuns.push(queueEntry);
        return run.status === "queued" ? null : run;
      }
      return await getRunOrThrow(store, run.runId);
    },
    processPlatformCheck: (checkId, dueAt, checkOptions = {}) =>
      execution.check(checkId, dueAt, {
        environment: checkOptions.environment ?? process.env,
      }),
  };
}
