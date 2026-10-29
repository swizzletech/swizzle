import { randomUUID } from "node:crypto";
import type { AutomationRuntimeConfig } from "@swizzle/config";
import type { WorkerCapabilities } from "@swizzle/db";
import { AutomationRuntimeError } from "./errors.js";
import type { ReadinessWorker } from "./platform-records.js";

export interface RunnerImageRequest {
  readonly id: string;
  readonly image: string;
}

export interface RunnerImageReport {
  readonly id: string;
  readonly result:
    | { readonly kind: "ready"; readonly capabilities: WorkerCapabilities }
    | { readonly kind: "unavailable"; readonly message: string };
}

/** Read-only requests stay with the API process; workers inspect images through their own broker. */
export interface RunnerImageChecks {
  workers(
    runtime: AutomationRuntimeConfig,
    workers: readonly ReadinessWorker[],
  ): Promise<readonly ReadinessWorker[]>;
  exchange(workerId: string, reports: readonly RunnerImageReport[]): readonly RunnerImageRequest[];
  close(): void;
}

/** Read-only image checks can be repeated after an API restart; they never authorize execution. */
export function createRunnerImageChecks(): RunnerImageChecks {
  const pending = new Map<
    string,
    {
      workerId: string;
      image: string;
      waiters: ((result: RunnerImageReport["result"]) => void)[];
      finish: (result: RunnerImageReport["result"]) => void;
    }
  >();
  let closed = false;
  const inspect = (workerId: string, image: string): Promise<WorkerCapabilities> => {
    if (closed)
      return Promise.reject(
        new AutomationRuntimeError(
          "RUNTIME_REQUIREMENTS_UNMET",
          "Runner image inspection is unavailable. Try validation again.",
        ),
      );
    return new Promise((resolve, reject) => {
      const complete = (result: RunnerImageReport["result"]) => {
        if (result.kind === "ready") resolve(result.capabilities);
        else
          reject(
            new AutomationRuntimeError(
              "RUNTIME_REQUIREMENTS_UNMET",
              `cannot check runner image ${image}: ${result.message}`,
            ),
          );
      };
      const existing = [...pending.values()].find(
        (request) => request.workerId === workerId && request.image === image,
      );
      if (existing) {
        existing.waiters.push(complete);
        return;
      }
      const id = randomUUID();
      const waiters = [complete];
      const finish = (result: RunnerImageReport["result"]) => {
        clearTimeout(timer);
        pending.delete(id);
        for (const waiter of waiters) waiter(result);
      };
      // Includes the worker's next poll and a storage operation on its Docker daemon.
      const timer = setTimeout(
        () => finish({ kind: "unavailable", message: "Runner image inspection timed out." }),
        80_000,
      );
      pending.set(id, { workerId, image, waiters, finish });
    });
  };
  return {
    workers: async (runtime, workers) => {
      const image = runtime.container?.base_image;
      if (image === undefined) return workers;
      return await Promise.all(
        workers.map(async (worker) => {
          if (
            worker.availability === "offline" ||
            !worker.profiles.some((profile) => profile.name === runtime.profile) ||
            !runtime.permissions.services.every((service) => worker.services.includes(service))
          )
            return worker;
          try {
            return { ...worker, capabilities: await inspect(worker.instanceId, image) };
          } catch (error) {
            return {
              ...worker,
              runnerImageError: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
    },
    exchange: (workerId, reports) => {
      for (const report of reports) {
        const request = pending.get(report.id);
        if (request?.workerId === workerId) request.finish(report.result);
      }
      return [...pending]
        .flatMap(([id, request]) =>
          request.workerId === workerId ? [{ id, image: request.image }] : [],
        )
        .slice(0, 8);
    },
    close: () => {
      closed = true;
      for (const request of pending.values())
        request.finish({ kind: "unavailable", message: "API stopped." });
    },
  };
}
