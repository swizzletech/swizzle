import { setTimeout as delay } from "node:timers/promises";
import { context as otContext, propagation } from "@opentelemetry/api";
import { LOCAL_LLM_SERVICE } from "@swizzle/config";
import { DEFAULT_WORKER_CONCURRENCY } from "@swizzle/core";
import type { RunImageDisk } from "@swizzle/db";
import { isDockerAvailable } from "./container-runner.js";
import { startDeploymentPreparation } from "./deployment-preparation.js";
import { closeDockerScopes, removeLeftoverContainers } from "./docker-cli.js";
import { localExecutionProtocol } from "./execution-protocol.js";
import { type ExecutionChannel, executeAssignment } from "./execution-wire.js";
import { localLlmHealth } from "./local-llm-access.js";
import type { PlatformWorkerController, StartPlatformWorkerOptions } from "./platform-types.js";
import { closeSandboxes } from "./sandbox.js";
import { createWakeGate } from "./wake-gate.js";
import { createWorkerRequest, WorkerHttpError } from "./worker-credential.js";
import {
  type ExecutionAssignment,
  OUTPUT_CHUNK_LENGTH,
  readWorkerReply,
  WORKER_ROUTES,
  type WorkerRoute,
} from "./worker-wire.js";

const OUTPUT_CHUNKS = new RegExp(`[\\s\\S]{1,${OUTPUT_CHUNK_LENGTH}}`, "gu");

/** A worker has one credential and initiates every request. It opens no control-plane store. */
export async function startPlatformWorkerService(
  options: StartPlatformWorkerOptions,
): Promise<PlatformWorkerController> {
  const origin = new URL(options.apiUrl);
  if (
    origin.protocol !== "https:" &&
    !(
      origin.protocol === "http:" &&
      (options.allowLocalHttp === true ||
        ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    )
  )
    throw new Error(
      "Workers require HTTPS, except on loopback or the explicitly configured same-host Compose network.",
    );
  if (origin.username || origin.password)
    throw new Error("Worker API URL must not contain credentials.");
  let closing = false;
  const pulls = new AbortController();
  const credentialShutdown = new AbortController();
  const wake = createWakeGate();
  const requireSandbox = (options.environment ?? process.env).SWIZZLE_REQUIRE_SANDBOX === "true";
  const dockerMissing = async () => requireSandbox && !(await isDockerAvailable());
  const request = await createWorkerRequest(
    origin,
    options.credential,
    credentialShutdown.signal,
    wake.observe,
  );
  const call = async <Request, Reply>(
    route: WorkerRoute<Request, Reply>,
    body: Request,
    signal?: AbortSignal,
  ): Promise<Reply> => readWorkerReply(route, await request(route.path, body, signal));
  const heartbeat = async (runImageDisk: RunImageDisk | null) =>
    call(WORKER_ROUTES.runtime, {
      capabilities: options.capabilities,
      services: { [LOCAL_LLM_SERVICE]: await localLlmHealth(options.environment ?? process.env) },
      runImageDisk,
    });
  for (let attempt = 0; ; attempt++) {
    try {
      await call(WORKER_ROUTES.drain, { draining: false });
      await heartbeat(null);
      break;
    } catch (error) {
      if (
        error instanceof WorkerHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      )
        throw error;
      options.logger?.warn({ error }, "Waiting for the worker API.");
      await delay(Math.min(5_000, 250 * 2 ** Math.min(attempt, 5)));
    }
  }
  if (await isDockerAvailable()) {
    const removed = await removeLeftoverContainers().catch((error: unknown) => {
      options.logger?.warn({ error }, "Could not list this stack's leftover containers.");
      return 0;
    });
    if (removed > 0)
      options.logger?.info({ removed }, "Removed leftover containers of this stack.");
  }
  const preparationAbort = new AbortController();
  const preparation = startDeploymentPreparation({
    poll: async (knownIds) =>
      await call(WORKER_ROUTES.preparations, { knownIds: [...knownIds] }, preparationAbort.signal),
    recordImage: async (deploymentId, tag) => {
      await call(WORKER_ROUTES.runImage, { deploymentId, tag }, preparationAbort.signal);
    },
    keptImages: async () =>
      (await call(WORKER_ROUTES.runImageKeep, {}, preparationAbort.signal)).keep,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  let beating = false;
  const heartbeatTimer = setInterval(() => {
    if (beating || closing) return;
    beating = true;
    void heartbeat(preparation.runImageDisk())
      .catch((error) => options.logger?.warn({ error }, "Worker heartbeat failed."))
      .finally(() => {
        beating = false;
      });
  }, 15_000);
  // Only a refusal ends ownership. A transport failure, HTTP 429 or 5xx may be a reconnect, so the
  // execution retries until its local deadline, which the server cannot extend behind its back.
  const refused = (error: unknown) =>
    error instanceof WorkerHttpError && error.status < 500 && error.status !== 429;
  const backoff = (attempt: number) => Math.min(1000, 100 * 2 ** Math.min(attempt, 4));
  const execute = async (assignment: ExecutionAssignment, receivedAt: number) => {
    let lease = assignment.lease;
    const owned = () => ({ lease: { taskId: lease.taskId, generation: lease.generation } });
    const abort = new AbortController();
    let sequence = 0;
    let output: Promise<unknown> = Promise.resolve();
    let renewing = false;
    let expiration: NodeJS.Timeout | undefined;
    let deadline = 0;
    const stopAtExpiry = () => {
      clearTimeout(expiration);
      expiration = setTimeout(() => abort.abort(), Math.max(0, deadline - performance.now()));
    };
    const callOwned = async <Request, Reply>(
      route: WorkerRoute<Request, Reply>,
      body: () => Request,
    ): Promise<Reply> => {
      for (let attempt = 0; ; attempt++) {
        abort.signal.throwIfAborted();
        if (performance.now() >= deadline) throw new Error("Execution lease was lost.");
        try {
          return await call(route, body(), abort.signal);
        } catch (error) {
          if (refused(error)) throw error;
          await delay(backoff(attempt), undefined, { signal: abort.signal });
        }
      }
    };
    const renew = async () => {
      if (renewing) return;
      renewing = true;
      const startedAt = performance.now();
      try {
        // A short timeout lets the next renewal open a fresh connection after a network change.
        const { lease: renewed } = await call(
          WORKER_ROUTES.renew,
          owned(),
          AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        );
        // A reply that arrives after the local deadline cannot revive it.
        if (abort.signal.aborted || performance.now() >= deadline) return;
        lease = renewed;
        deadline = startedAt + lease.remainingMs - 100;
        stopAtExpiry();
      } catch (error) {
        if (refused(error)) abort.abort();
        throw error;
      } finally {
        renewing = false;
      }
    };
    // The pull reply may have waited behind preparation, so its validity has no local start. Nothing
    // runs until a renewal measured from this side sets the deadline. Shutdown gives the unstarted
    // execution up; the server requeues it without spending an attempt.
    const establish = async () => {
      for (let attempt = 0; ; attempt++) {
        if (closing) throw new Error("Worker is closing before the execution started.");
        const startedAt = performance.now();
        try {
          ({ lease } = await call(
            WORKER_ROUTES.renew,
            owned(),
            AbortSignal.any([pulls.signal, AbortSignal.timeout(10_000)]),
          ));
          deadline = startedAt + lease.remainingMs - 100;
          if (performance.now() >= deadline)
            throw new Error("Execution lease was lost in transit.");
          stopAtExpiry();
          return;
        } catch (error) {
          if (refused(error) || performance.now() >= receivedAt + assignment.lease.remainingMs)
            throw error;
          await delay(backoff(attempt), undefined, { signal: pulls.signal });
        }
      }
    };
    await establish();
    // The renewal may be the first reply after a pause, or Docker may have stopped while the pull
    // waited. Nothing has run yet, so the server requeues it at lease expiry without spending an
    // attempt.
    if (!wake.settled()) throw new Error("Host was asleep; leaving the assignment unstarted.");
    if (await dockerMissing())
      throw new Error("Docker broker unavailable; leaving the assignment unstarted.");
    const channel: ExecutionChannel = {
      source: async () => (await callOwned(WORKER_ROUTES.source, owned)).files,
      start: async () => (await callOwned(WORKER_ROUTES.start, owned)).secrets,
      ready: async () => {
        await callOwned(WORKER_ROUTES.ready, owned);
      },
      output: (stream, chunk) => {
        // By code point, so a chunk boundary never splits a surrogate pair.
        for (const part of chunk.match(OUTPUT_CHUNKS) ?? []) {
          const index = ++sequence;
          output = output.then(() =>
            callOwned(WORKER_ROUTES.output, () => ({
              ...owned(),
              sequence: index,
              stream,
              chunk: part,
            })),
          );
          void output.catch(() => abort.abort());
        }
        return output.then(() => {});
      },
    };
    const timer = setInterval(
      () => {
        void renew().catch((error) =>
          options.logger?.warn(
            { error },
            refused(error)
              ? "Execution lease refused; stopping sandbox."
              : "Execution lease renewal failed; retrying until the local deadline.",
          ),
        );
      },
      Math.max(100, Math.min(2_000, lease.remainingMs / 3)),
    );
    try {
      const report = await executeAssignment({
        assignment,
        channel,
        environment: options.environment ?? process.env,
        executor: localExecutionProtocol,
        signal: abort.signal,
      });
      await output;
      if (abort.signal.aborted || performance.now() >= deadline)
        throw new Error("Execution lease was lost.");
      await callOwned(WORKER_ROUTES.complete, () => ({ ...owned(), report }));
    } finally {
      clearInterval(timer);
      clearTimeout(expiration);
      abort.abort();
      await output.catch(() => {});
    }
  };
  const loop = async () => {
    let failures = 0;
    while (!closing) {
      try {
        if (await dockerMissing())
          throw new Error("Docker broker unavailable; worker is not accepting assignments.");
        await wake.untilSettled(pulls.signal);
        const { assignment } = await call(WORKER_ROUTES.pull, {}, pulls.signal);
        if (assignment !== null)
          await otContext.with(
            propagation.extract(otContext.active(), assignment.traceContext),
            () => execute(assignment, performance.now()),
          );
        failures = 0;
        if (assignment === null) await delay(250);
      } catch (error) {
        if (closing) return;
        options.logger?.warn({ error }, "Worker request failed; retrying.");
        await delay(
          Math.min(5_000, 250 * 2 ** Math.min(++failures, 5)) + Math.floor(Math.random() * 100),
        );
      }
    }
  };
  const loops = Array.from({ length: options.concurrency ?? DEFAULT_WORKER_CONCURRENCY }, loop);
  return {
    async close() {
      closing = true;
      credentialShutdown.abort();
      pulls.abort();
      clearInterval(heartbeatTimer);
      preparationAbort.abort();
      await call(WORKER_ROUTES.drain, { draining: true }, AbortSignal.timeout(10_000)).catch(
        (error) =>
          options.logger?.warn(
            { error },
            "Worker API unavailable during drain; closing local resources.",
          ),
      );
      await Promise.all(loops);
      await preparation.close();
      await closeSandboxes();
      await closeDockerScopes();
    },
  };
}
