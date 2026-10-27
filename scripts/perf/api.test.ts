import { EventEmitter, once, setMaxListeners } from "node:events";
import { createServer, type RequestListener } from "node:http";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { temporaryDirectory } from "../../test/support.ts";
import type { PackagedStack } from "../packaged-stack.mts";
import { routeRound, triggerRun, waitForRun } from "./api.mts";
import { Rounds } from "./result.ts";

async function stackServing(listener: RequestListener): Promise<PackagedStack> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP listener required");
  const unused = async (): Promise<never> => {
    throw new Error("not used by API requests");
  };
  return {
    api: `http://127.0.0.1:${address.port}`,
    dashboard: `http://127.0.0.1:${address.port}`,
    links: `http://127.0.0.1:${address.port}`,
    environment: "staging",
    project: "route-test",
    token: "token",
    session: { name: "session", value: "owner" },
    cli: unused,
    compose: unused,
    remove: unused,
  };
}

test("a complete route round does not retain fetch listeners on a shared abort signal", async () => {
  let requests = 0;
  const stack = await stackServing((_request, response) => {
    requests += 1;
    response.end("{}");
  });
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    // Eight concurrent clients need fewer than sixteen active abort listeners. Lower the
    // warning threshold so this check does not depend on GC or Node's automatic limit growth.
    if (init?.signal) setMaxListeners(16, init.signal);
    return fetch(input, init);
  });
  const emitWarning = process.emitWarning.bind(process);
  const warnings: string[] = [];
  vi.spyOn(process, "emitWarning").mockImplementation((warning, ...args) => {
    if (warning instanceof Error && warning.name === "MaxListenersExceededWarning") {
      warnings.push(warning.message);
    } else emitWarning(warning, ...args);
  });
  vi.stubEnv("DOCKER_HOST", "unix:///unused-stats.sock");
  const rounds = new Rounds();
  await routeRound(stack, [], "seed", rounds);
  expect(requests).toBe(2000);
  expect(
    rounds
      .metrics()
      .filter((entry) => entry.name === "errors")
      .map((entry) => entry.max),
  ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(warnings).toEqual([]);
}, 30_000);

test("a request's derived signal still cancels an unfinished response with its parent", async () => {
  const events = new EventEmitter();
  const started = once(events, "request");
  const stack = await stackServing(() => events.emit("request"));
  const parent = new AbortController();
  const result = expect(triggerRun(stack, {}, parent.signal)).rejects.toThrow("cancel request");
  await started;
  parent.abort(new Error("cancel request"));
  await result;
});

/** Answers every Docker stats read with valid stats; returns how many reads it answered. */
async function statsServing(): Promise<() => number> {
  const socket = path.join(await temporaryDirectory("perf-api-stats-"), "docker.sock");
  let reads = 0;
  const server = createServer((_request, response) => {
    reads += 1;
    response.end(
      JSON.stringify({
        cpu_stats: { cpu_usage: { total_usage: 1e9 } },
        memory_stats: { stats: { anon: 2 ** 20, shmem: 0, thp_fault_alloc: 0 } },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  vi.stubEnv("DOCKER_HOST", `unix://${socket}`);
  return () => reads;
}

/** A server that accepts each request and stalls its headers, or its body after one byte. */
function stalling(phase: string): RequestListener {
  return (_request, response) => {
    if (phase === "body") {
      response.writeHead(200);
      response.write("{");
    }
  };
}

/** Cuts every deadline to at most one second; stats reads still finish well within it. */
function shortDeadlines(): void {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(Math.min(ms, 1_000)));
}

test.each(["headers", "body"])(
  "a measured route round whose response stalls its %s fails with a timeout while stats succeed",
  async (phase) => {
    const stack = await stackServing(stalling(phase));
    const statsReads = await statsServing();
    shortDeadlines();

    await expect(
      routeRound(stack, [{ containerId: "api", name: "api" }], "seed", new Rounds()),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    // The round started with a stats read, and a failed read would have rejected with its error instead.
    expect(statsReads()).toBeGreaterThanOrEqual(1);
  },
);

test.each(["headers", "body"])(
  "a run trigger and a run wait that stall their %s time out under a lifecycle signal",
  async (phase) => {
    const stack = await stackServing(stalling(phase));
    const lifecycle = new AbortController().signal;
    shortDeadlines();

    await expect(triggerRun(stack, {}, lifecycle)).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(waitForRun(stack, "run", lifecycle)).rejects.toMatchObject({
      name: "TimeoutError",
    });
  },
);
