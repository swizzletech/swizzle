import { randomUUID } from "node:crypto";
import type { AutomationRuntimeConfig } from "@swizzle/config";
import type { ReadinessWorker, RunnerImageResult } from "./platform-records.js";

export interface RunnerImageRequest {
  readonly id: string;
  readonly image: string;
}

export interface RunnerImageReport {
  readonly id: string;
  readonly result: RunnerImageResult;
}

/** Read-only requests stay with the API process; workers inspect images through their own broker. */
export interface RunnerImageChecks {
  workers(
    runtime: AutomationRuntimeConfig,
    workers: readonly ReadinessWorker[],
    /** Stops this caller's wait without ending a shared inspection for other callers. */
    signal?: AbortSignal,
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
  const inspect = (
    workerId: string,
    image: string,
    signal?: AbortSignal,
  ): Promise<RunnerImageReport["result"]> => {
    if (closed)
      return Promise.resolve({
        kind: "unavailable",
        message: "Runner image inspection is unavailable. Try validation again.",
      });
    return new Promise((resolve) => {
      const complete = (result: RunnerImageReport["result"]) => {
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () =>
        complete({
          kind: "unavailable",
          message:
            "Runner image inspection did not finish before the response deadline. Try again.",
        });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
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
    workers: async (runtime, workers, signal) => {
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
          return { ...worker, runnerImage: await inspect(worker.instanceId, image, signal) };
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
