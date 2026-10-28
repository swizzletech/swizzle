import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { heldDeadlines, temporaryDirectory } from "../../test/support.ts";
import { STATS_TIMEOUT_MS } from "./resources.mts";

test("sampling preserves the workload value, cumulative CPU delta and cgroup v2 memory", async () => {
  const socket = path.join(await temporaryDirectory("perf-stats-"), "docker.sock");
  let reads = 0;
  const server = createServer((_request, response) => {
    reads += 1;
    response.end(
      JSON.stringify({
        cpu_stats: { cpu_usage: { total_usage: reads === 1 ? 1e9 : 4e9 } },
        memory_stats: { stats: { anon: reads * 2 ** 20, shmem: 2 ** 20, thp_fault_alloc: 2 } },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  vi.stubEnv("DOCKER_HOST", `unix://${socket}`);
  vi.resetModules();
  const { whileSampling } = await import("./resources.mts");
  const result = await whileSampling(
    [{ containerId: "container", name: "worker" }],
    async () => 42,
  );
  expect(result.value).toBe(42);
  expect([...result.usage]).toEqual([
    ["worker", { cpuSeconds: 3, hugePagesMiB: 4, rssPeakMiB: 3 }],
  ]);
});

test("a service's replicas report the sum of their containers", async () => {
  const reads = new Map<string, number>();
  const { whileSampling } = await statsServer((request, response) => {
    const container = request.url?.split("/")[2] ?? "";
    const read = (reads.get(container) ?? 0) + 1;
    reads.set(container, read);
    // Replica a uses 1 CPU second and 2 MiB, replica b 2 CPU seconds and 3 MiB.
    const scale = container === "a" ? 1 : 2;
    response.end(
      JSON.stringify({
        cpu_stats: { cpu_usage: { total_usage: (read === 1 ? 0 : scale) * 1e9 } },
        memory_stats: { stats: { anon: (scale + 1) * 2 ** 20, shmem: 0, thp_fault_alloc: 1 } },
      }),
    );
  });
  const result = await whileSampling(
    [
      { containerId: "a", name: "worker" },
      { containerId: "b", name: "worker" },
    ],
    async () => 42,
  );
  expect([...result.usage]).toEqual([
    ["worker", { cpuSeconds: 3, hugePagesMiB: 4, rssPeakMiB: 5 }],
  ]);
});

async function statsServer(handler: RequestListener) {
  const socket = path.join(await temporaryDirectory("perf-stats-"), "docker.sock");
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  vi.stubEnv("DOCKER_HOST", `unix://${socket}`);
  return await import("./resources.mts");
}

const validStats = JSON.stringify({
  cpu_stats: { cpu_usage: { total_usage: 1e9 } },
  memory_stats: { stats: { rss: 2 ** 20, rss_huge: 0 } },
});

test.each([
  ["malformed JSON", "{", 200, "invalid JSON"],
  [
    "invalid counters",
    '{"cpu_stats":{"cpu_usage":{"total_usage":null}},"memory_stats":{}}',
    200,
    "invalid stats counter",
  ],
  ["HTTP error", "unavailable", 503, "HTTP 503"],
  ["oversized body", "x".repeat(2 ** 20 + 1), 200, "response exceeds 1 MiB"],
])("stats rejects %s with the container named", async (_label, body, status, error) => {
  const { whileSampling } = await statsServer((_request, response) => {
    response.writeHead(status);
    response.end(body);
  });
  await expect(
    whileSampling([{ containerId: "broken", name: "worker" }], async () => 42),
  ).rejects.toThrow(`Docker stats broken: ${error}`);
});

test("a sampler failure cancels and drains a workload that has not finished", async () => {
  let reads = 0;
  const { whileSampling } = await statsServer((_request, response) => {
    reads += 1;
    response.writeHead(reads === 1 ? 200 : 503);
    response.end(validStats);
  });
  let stopped = false;
  await expect(
    whileSampling([{ containerId: "worker", name: "worker" }], async (signal) => {
      try {
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      } finally {
        stopped = true;
      }
    }),
  ).rejects.toThrow("Docker stats worker: HTTP 503");
  expect(stopped).toBe(true);
});

test.each(["headers", "body"])("stats bounds a stalled %s read", async (phase) => {
  // The read's deadline ends once the stall is in place: at the request for the headers, and right
  // after the client took the response for the body.
  const deadlines = heldDeadlines(STATS_TIMEOUT_MS);
  if (phase === "body") {
    const expire = () => queueMicrotask(() => deadlines.expire());
    subscribe("http.client.response.finish", expire);
    onTestFinished(() => {
      unsubscribe("http.client.response.finish", expire);
    });
  }
  const { whileSampling } = await statsServer((_request, response) => {
    if (phase === "body") {
      response.writeHead(200);
      response.write("{");
    } else deadlines.expire();
  });
  await expect(
    whileSampling([{ containerId: "stalled", name: "worker" }], async () => 42),
  ).rejects.toThrow("Docker stats stalled: timed out after 5000 ms");
});

test("a truncated stats response rejects through the adapter", async () => {
  const { whileSampling } = await statsServer((_request, response) => {
    response.writeHead(200, { "content-length": 100 });
    response.write("{");
    response.socket?.destroy();
  });
  await expect(
    whileSampling([{ containerId: "truncated", name: "worker" }], async () => 42),
  ).rejects.toThrow("Docker stats truncated:");
});

test("a workload error cancels a stats read already in flight", async () => {
  let reads = 0;
  const events = new EventEmitter();
  const inFlight = once(events, "read");
  const { whileSampling } = await statsServer((_request, response) => {
    reads += 1;
    if (reads === 1) response.end(validStats);
    else events.emit("read");
  });
  await expect(
    whileSampling([{ containerId: "busy", name: "worker" }], async () => {
      await inFlight;
      throw new Error("workload failed");
    }),
  ).rejects.toThrow("workload failed");
});
