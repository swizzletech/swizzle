import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FINISHED_RUN_STATUSES } from "@swizzle/db";
import type { PackagedStack } from "../packaged-stack.mts";
import { type Sampled, type Service, whileSampling } from "./resources.mts";
import { quantile, type Rounds } from "./result.ts";

export const API_PROFILE = {
  apiConcurrency: 8,
  apiRequestsPerRound: 200,
  apiWarmupRequests: 50,
  burstRuns: 10,
  deploysPerRound: 1,
  referenceAutomation: "hello-webhook",
  sequentialRuns: 10,
} as const;

export const OPERATION_TIMEOUT_MS = 60_000;
const POLL_MS = 50;
const PREPARE_TIMEOUT_MS = 60_000;
const PREPARE_POLL_MS = 250;

type Auth = "session" | "token";

interface Route {
  readonly label: string;
  readonly path: string;
  readonly auth: Auth;
}

function routes(stack: PackagedStack, runId: string): Route[] {
  const environment = `environment=${stack.environment}`;
  const automation = API_PROFILE.referenceAutomation;
  const session = (label: string, path: string): Route => ({ auth: "session", label, path });
  return [
    session("/health", "/health"),
    session("/auth/status", "/auth/status"),
    session("/dashboard/overview", `/dashboard/overview?${environment}`),
    session("/dashboard/automations", `/dashboard/automations?${environment}`),
    session("/dashboard/automations/:name", `/dashboard/automations/${automation}?${environment}`),
    session("/dashboard/runs", `/dashboard/runs?${environment}`),
    { auth: "token", label: "/dashboard/runs (token)", path: `/dashboard/runs?${environment}` },
    session("/dashboard/runs/:runId", `/dashboard/runs/${runId}`),
    session("/ops/summary", `/ops/summary?${environment}`),
    session("/secrets", `/secrets?${environment}`),
  ];
}

function credentials(stack: PackagedStack, auth: Auth): Record<string, string> {
  return auth === "token"
    ? { authorization: `Bearer ${stack.token}` }
    : { cookie: `${stack.session.name}=${stack.session.value}` };
}

interface Load {
  readonly latencies: number[];
  readonly seconds: number;
  readonly errors: number;
}

function operationSignal(lifecycle: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
  return lifecycle === undefined ? deadline : AbortSignal.any([deadline, lifecycle]);
}

async function load(
  stack: PackagedStack,
  route: Route,
  total: number,
  lifecycle?: AbortSignal,
): Promise<Load> {
  const signal = operationSignal(lifecycle);
  const url = `${stack.dashboard}/api${route.path}`;
  const headers = credentials(stack, route.auth);
  const latencies: number[] = [];
  let issued = 0;
  let errors = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: API_PROFILE.apiConcurrency }, async () => {
      while (issued < total) {
        issued += 1;
        const sent = performance.now();
        const response = await fetch(url, { headers, signal: AbortSignal.any([signal]) });
        await response.arrayBuffer();
        latencies.push(performance.now() - sent);
        if (!response.ok) errors += 1;
      }
    }),
  );
  return { errors, latencies, seconds: (performance.now() - started) / 1000 };
}

interface RunTimes {
  readonly status: string;
  readonly queuedAt: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export async function triggerRun(
  stack: PackagedStack,
  payload: unknown,
  lifecycle?: AbortSignal,
): Promise<{ readonly runId: string; readonly triggerMs: number }> {
  const signal = operationSignal(lifecycle);
  const sent = performance.now();
  const response = await fetch(
    `${stack.dashboard}/api/automations/${API_PROFILE.referenceAutomation}/runs?environment=${stack.environment}`,
    {
      body: JSON.stringify(payload),
      headers: { ...credentials(stack, "token"), "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.any([signal]),
    },
  );
  const body = await response.text();
  const triggerMs = performance.now() - sent;
  if (!response.ok) throw new Error(`The trigger answered ${response.status}: ${body}`);
  return { runId: (JSON.parse(body) as { runId: string }).runId, triggerMs };
}

export async function waitForRun(
  stack: PackagedStack,
  runId: string,
  lifecycle?: AbortSignal,
): Promise<RunTimes> {
  const signal = operationSignal(lifecycle);
  for (;;) {
    const response = await fetch(`${stack.dashboard}/api/runs/${runId}`, {
      headers: credentials(stack, "token"),
      signal: AbortSignal.any([signal]),
    });
    if (response.ok) {
      const run = (await response.json()) as {
        status: string;
        queuedAt: string;
        startedAt: string | null;
        finishedAt: string | null;
      };
      if (FINISHED_RUN_STATUSES.some((status) => status === run.status)) {
        return {
          finishedAt: Date.parse(run.finishedAt ?? ""),
          queuedAt: Date.parse(run.queuedAt),
          startedAt: Date.parse(run.startedAt ?? run.queuedAt),
          status: run.status,
        };
      }
    } else await response.arrayBuffer();
    await delay(POLL_MS, undefined, { signal });
  }
}

function recordUsage(rounds: Rounds, phase: string, { seconds, usage }: Sampled<unknown>): void {
  rounds.record("phase duration", phase, "s", "lower", seconds);
  for (const [service, { cpuSeconds, hugePagesMiB, rssPeakMiB }] of usage) {
    rounds.record(`service ${service}`, `cpu ${phase}`, "cpu-s", "lower", cpuSeconds);
    rounds.record(`service ${service}`, `rss ${phase}`, "MiB", "lower", rssPeakMiB, hugePagesMiB);
  }
}

export async function warmRoutes(stack: PackagedStack, seedRunId: string): Promise<void> {
  for (const route of routes(stack, seedRunId)) {
    await load(stack, route, API_PROFILE.apiWarmupRequests);
  }
}

export async function routeRound(
  stack: PackagedStack,
  services: readonly Service[],
  seedRunId: string,
  rounds: Rounds,
): Promise<void> {
  const sampled = await whileSampling(services, async (signal) => {
    const results: Array<[string, Load]> = [];
    for (const route of routes(stack, seedRunId)) {
      results.push([
        route.label,
        await load(stack, route, API_PROFILE.apiRequestsPerRound, signal),
      ]);
    }
    return results;
  });
  for (const [label, { errors, latencies, seconds }] of sampled.value) {
    const group = `GET ${label}`;
    rounds.record(group, "p50", "ms", "lower", quantile(latencies, 0.5));
    rounds.record(group, "p95", "ms", "lower", quantile(latencies, 0.95));
    rounds.record(group, "p99", "ms", "lower", quantile(latencies, 0.99));
    rounds.record(group, "throughput", "req/s", "higher", latencies.length / seconds);
    rounds.record(group, "errors", "count", "lower", errors);
  }
  recordUsage(rounds, "routes", sampled);
}

interface Phases {
  readonly image: number;
  readonly sandbox: number;
  readonly process: number;
  readonly standby: boolean;
}

type MeasuredRun = RunTimes & { readonly phases: Phases | null };

async function phasesOf(stack: PackagedStack, runId: string, lifecycle: AbortSignal) {
  const response = await fetch(`${stack.dashboard}/api/dashboard/runs/${runId}`, {
    headers: credentials(stack, "token"),
    signal: operationSignal(lifecycle),
  });
  if (!response.ok) throw new Error(`Run ${runId} detail answered ${response.status}.`);
  const run = (await response.json()) as {
    attempts: Array<{ metadata: { phases?: Partial<Phases> } | null }>;
  };
  const phases = run.attempts.at(-1)?.metadata?.phases;
  if (phases?.sandbox === undefined || phases.process === undefined) return null;
  return {
    image: phases.image ?? 0,
    process: phases.process,
    sandbox: phases.sandbox,
    standby: phases.standby ?? false,
  };
}

async function measuredRun(
  stack: PackagedStack,
  payload: unknown,
  signal: AbortSignal,
): Promise<MeasuredRun & { readonly triggerMs: number }> {
  const { runId, triggerMs } = await triggerRun(stack, payload, signal);
  const times = await waitForRun(stack, runId, signal);
  return { ...times, phases: await phasesOf(stack, runId, signal), triggerMs };
}

async function deployNewVersion(stack: PackagedStack): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-perf-version-"));
  try {
    const source = path.join(directory, API_PROFILE.referenceAutomation);
    await cp(path.join("infra/examples", API_PROFILE.referenceAutomation), source, {
      recursive: true,
    });
    await appendFile(path.join(source, "main.py"), `\n# perf version ${randomUUID()}\n`);
    const output = JSON.parse(await stack.cli("apply", source)) as {
      deployment: { id: string };
    };
    return output.deployment.id;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function waitForPrepared(
  stack: PackagedStack,
  deploymentId: string,
  workers: number,
  signal: AbortSignal,
): Promise<number | null> {
  const since = new Date(Date.now() - 1_000).toISOString();
  const started = performance.now();
  let outcomes: Array<{ msg: string; err?: { message?: string } }> = [];
  while (performance.now() - started < PREPARE_TIMEOUT_MS) {
    const logs = await stack.compose(
      "logs",
      "--no-color",
      "--no-log-prefix",
      "--since",
      since,
      "worker",
    );
    outcomes = logs.split("\n").flatMap((line) => {
      try {
        const entry = JSON.parse(line) as {
          msg?: unknown;
          deploymentId?: unknown;
          err?: { message?: string };
        };
        return entry.deploymentId === deploymentId && typeof entry.msg === "string"
          ? [{ msg: entry.msg, ...(entry.err !== undefined ? { err: entry.err } : {}) }]
          : [];
      } catch {
        return [];
      }
    });
    const prepared = outcomes.filter((entry) => entry.msg === "Prepared deployment.").length;
    if (prepared >= workers) return performance.now() - started;
    if (outcomes.length >= workers) break;
    await delay(PREPARE_POLL_MS, undefined, { signal });
  }
  const failed = outcomes.filter((entry) => entry.msg !== "Prepared deployment.");
  if (outcomes.length > 0) {
    const missing = workers - (outcomes.length - failed.length);
    const reasons = failed.map((entry) => `; ${entry.msg} ${entry.err?.message ?? ""}`).join("");
    process.stderr.write(
      `perf: ${missing} of ${workers} workers did not prepare ${deploymentId}${reasons}\n`,
    );
  }
  return null;
}

function recordRuns(
  rounds: Rounds,
  group: string,
  runs: readonly MeasuredRun[],
  suffix: string,
): void {
  const record = (name: string, values: readonly number[]) =>
    rounds.record(group, `${name}${suffix}`, "ms", "lower", quantile(values, 0.5));
  record(
    "queued",
    runs.map((run) => run.startedAt - run.queuedAt),
  );
  record("execute", runs.map(executeMs));
  const phases = runs.flatMap((run) => (run.phases === null ? [] : [{ ...run.phases, run }]));
  if (phases.length !== runs.length) return;
  record(
    "image",
    phases.map((entry) => entry.image),
  );
  record(
    "sandbox",
    phases.map((entry) => entry.sandbox),
  );
  record(
    "process",
    phases.map((entry) => entry.process),
  );
  record(
    "other",
    phases.map((entry) => executeMs(entry.run) - entry.image - entry.sandbox - entry.process),
  );
  rounds.record(
    group,
    "standby",
    "count",
    "higher",
    phases.filter((entry) => entry.standby).length,
  );
}

function executeMs(run: RunTimes): number {
  return run.finishedAt - run.startedAt;
}

export async function deployRound(
  stack: PackagedStack,
  services: readonly Service[],
  round: number,
  rounds: Rounds,
): Promise<void> {
  const workers = services.filter((service) => service.name === "worker").length;
  const sampled = await whileSampling(services, async (signal) => {
    const deploymentId = await deployNewVersion(stack);
    const preparedMs = await waitForPrepared(stack, deploymentId, workers, signal);
    const first = await measuredRun(stack, { first: true, round }, signal);
    return { first, preparedMs };
  });
  const { first, preparedMs } = sampled.value;
  const group = `first run ${API_PROFILE.referenceAutomation}`;
  if (preparedMs !== null) rounds.record(group, "prepared", "ms", "lower", preparedMs);
  recordRuns(rounds, group, [first], "");
  rounds.record(group, "failed", "count", "lower", first.status === "succeeded" ? 0 : 1);
  recordUsage(rounds, "deploy", sampled);
}

export async function runRound(
  stack: PackagedStack,
  services: readonly Service[],
  round: number,
  rounds: Rounds,
): Promise<void> {
  const sampled = await whileSampling(services, async (signal) => {
    const sequential: Array<MeasuredRun & { triggerMs: number }> = [];
    for (let index = 0; index < API_PROFILE.sequentialRuns; index += 1) {
      sequential.push(await measuredRun(stack, { round, run: index }, signal));
    }
    const triggered = await Promise.all(
      Array.from({ length: API_PROFILE.burstRuns }, (_, index) =>
        triggerRun(stack, { burst: index, round }, signal),
      ),
    );
    const burst = await Promise.all(triggered.map(({ runId }) => waitForRun(stack, runId, signal)));
    return { burst, sequential };
  });
  const { burst, sequential } = sampled.value;
  const p50 = (values: readonly number[]) => quantile(values, 0.5);
  const queued = (runs: readonly RunTimes[]) => runs.map((run) => run.startedAt - run.queuedAt);
  const total = (runs: readonly RunTimes[]) => runs.map((run) => run.finishedAt - run.queuedAt);

  const group = `run ${API_PROFILE.referenceAutomation}`;
  rounds.record(group, "trigger p50", "ms", "lower", p50(sequential.map((run) => run.triggerMs)));
  recordRuns(rounds, group, sequential, " p50");
  rounds.record(group, "total p50", "ms", "lower", p50(total(sequential)));
  rounds.record(group, "total p95", "ms", "lower", quantile(total(sequential), 0.95));
  rounds.record(group, "total p99", "ms", "lower", quantile(total(sequential), 0.99));
  const failed = [...sequential, ...burst].filter((run) => run.status !== "succeeded").length;
  rounds.record(group, "failed", "count", "lower", failed);

  const burstGroup = `burst of ${API_PROFILE.burstRuns} runs`;
  const seconds =
    (Math.max(...burst.map((run) => run.finishedAt)) -
      Math.min(...burst.map((run) => run.queuedAt))) /
    1000;
  rounds.record(burstGroup, "throughput", "runs/s", "higher", burst.length / seconds);
  rounds.record(burstGroup, "queued p50", "ms", "lower", p50(queued(burst)));
  rounds.record(burstGroup, "execute p50", "ms", "lower", p50(burst.map(executeMs)));
  rounds.record(burstGroup, "total p95", "ms", "lower", quantile(total(burst), 0.95));
  recordUsage(rounds, "runs", sampled);
}
