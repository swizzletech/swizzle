import { execFileSync } from "node:child_process";
import { type IncomingMessage, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export interface Service {
  readonly name: string;
  readonly containerId: string;
}

interface Usage {
  readonly cpuSeconds: number;
  readonly rssPeakMiB: number;
  readonly hugePagesMiB: number;
}

interface Sample {
  readonly cpuNanoseconds: number;
  readonly rssBytes: number;
  readonly hugePageBytes: number;
}

const SAMPLE_MS = 250;
const HUGE_PAGE = 2 * 2 ** 20;

function dockerSocket(): string {
  const host =
    process.env.DOCKER_HOST ||
    execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
      encoding: "utf8",
    }).trim();
  if (!host.startsWith("unix://")) {
    throw new Error(`perf reads container stats over a unix socket; the docker host is ${host}.`);
  }
  return host.slice("unix://".length);
}

export const STATS_TIMEOUT_MS = 5_000;
const MAX_STATS_BYTES = 2 ** 20;

async function sample(socketPath: string, containerId: string, stop: AbortSignal): Promise<Sample> {
  const deadline = AbortSignal.timeout(STATS_TIMEOUT_MS);
  const signal = AbortSignal.any([stop, deadline]);
  const req = request({
    path: `/containers/${containerId}/stats?stream=false&one-shot=true`,
    signal,
    socketPath,
  });
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      req.once("response", resolve);
      req.once("error", reject);
      req.end();
    });
    if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
    let body = "";
    response.setEncoding("utf8");
    for await (const chunk of response) {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_STATS_BYTES) throw new Error("response exceeds 1 MiB");
    }
    const stats: unknown = JSON.parse(body);
    const object = (value: unknown): Record<string, unknown> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("invalid stats object");
      }
      return value as Record<string, unknown>;
    };
    const number = (value: unknown): number => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error("invalid stats counter");
      }
      return value;
    };
    const root = object(stats);
    const cpu = object(object(root.cpu_stats).cpu_usage);
    const memory = object(object(root.memory_stats).stats ?? {});
    const counter = (key: string) => number(memory[key] ?? 0);
    return {
      cpuNanoseconds: number(cpu.total_usage),
      hugePageBytes:
        memory.anon === undefined
          ? counter("rss_huge")
          : (counter("thp_fault_alloc") + counter("thp_collapse_alloc")) * HUGE_PAGE,
      rssBytes: memory.anon === undefined ? counter("rss") : counter("anon") + counter("shmem"),
    };
  } catch (cause) {
    const reason = deadline.aborted
      ? `timed out after ${STATS_TIMEOUT_MS} ms`
      : cause instanceof SyntaxError
        ? `invalid JSON: ${cause.message}`
        : cause instanceof Error
          ? cause.message
          : String(cause);
    throw new Error(`Docker stats ${containerId}: ${reason}`, { cause });
  } finally {
    req.destroy();
  }
}

export interface Sampled<T> {
  readonly value: T;
  readonly seconds: number;
  readonly usage: ReadonlyMap<string, Usage>;
}

export async function whileSampling<T>(
  services: readonly Service[],
  work: (signal: AbortSignal) => Promise<T>,
): Promise<Sampled<T>> {
  const socketPath = dockerSocket();
  const lifetime = new AbortController();
  const sampling = new AbortController();
  const all = (signal: AbortSignal) =>
    Promise.all(services.map((service) => sample(socketPath, service.containerId, signal)));
  const pending: Promise<unknown>[] = [];
  const names = [...new Set(services.map((service) => service.name))];
  const sum = (samples: readonly Sample[], value: (entry: Sample) => number) =>
    new Map(
      names.map((name) => [
        name,
        samples.reduce(
          (total, entry, index) => (services[index]?.name === name ? total + value(entry) : total),
          0,
        ),
      ]),
    );
  const peaks = new Map(names.map((name) => [name, 0]));
  const hugePages = new Map(names.map((name) => [name, 0]));
  const keepPeak = (into: Map<string, number>, sums: ReadonlyMap<string, number>) => {
    for (const [name, bytes] of sums) into.set(name, Math.max(into.get(name) ?? 0, bytes));
  };
  const record = (samples: readonly Sample[]) => {
    keepPeak(
      peaks,
      sum(samples, (entry) => entry.rssBytes),
    );
    keepPeak(
      hugePages,
      sum(samples, (entry) => entry.hugePageBytes),
    );
  };

  try {
    const start = await all(lifetime.signal);
    record(start);
    const started = performance.now();
    const sampler = (async (): Promise<never> => {
      for (;;) {
        await delay(SAMPLE_MS, undefined, { signal: sampling.signal });
        record(await all(sampling.signal));
      }
    })();
    const workload = Promise.resolve().then(async () => {
      const value = await work(lifetime.signal);
      return { seconds: (performance.now() - started) / 1000, value };
    });
    pending.push(sampler, workload);
    const { value, seconds } = await Promise.race([workload, sampler]);
    sampling.abort();
    const end = await all(lifetime.signal);
    record(end);
    const cpuBefore = sum(start, (entry) => entry.cpuNanoseconds);
    const cpuAfter = sum(end, (entry) => entry.cpuNanoseconds);
    const usage = new Map(
      names.map((name) => [
        name,
        {
          cpuSeconds: ((cpuAfter.get(name) ?? 0) - (cpuBefore.get(name) ?? 0)) / 1e9,
          hugePagesMiB: (hugePages.get(name) ?? 0) / 2 ** 20,
          rssPeakMiB: (peaks.get(name) ?? 0) / 2 ** 20,
        },
      ]),
    );
    return { seconds, usage, value };
  } finally {
    lifetime.abort();
    sampling.abort();
    await Promise.allSettled(pending);
  }
}
