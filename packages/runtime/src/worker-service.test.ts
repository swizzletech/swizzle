import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionLease } from "@swizzle/db";
import { expect, it, onTestFinished, vi } from "vitest";
import { temporaryDirectory, waitFor } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";
import { createExecutionDelivery } from "./execution-wire.js";

const lease: ExecutionLease = {
  taskId: "run:00000000-0000-4000-8000-000000000002",
  runId: "00000000-0000-4000-8000-000000000002",
  checkId: null,
  dueAt: null,
  workerId: "00000000-0000-4000-8000-000000000003",
  generation: 1,
  executionNumber: 1,
  expiresAt: "1970-01-01T00:00:00.000Z",
  remainingMs: 3_000,
};

interface Faults {
  /** Use a file credential and stall its candidate probe after the clock enters renewal time. */
  readonly stalledTokenRenewal?: boolean;
  /** Renewal replies after the first wait this long. */
  readonly delayedRenewal?: boolean;
  /** The first source reply stops halfway through its body. */
  readonly cutSource?: boolean;
  /** Renewals answer 503 for this long after the attempt starts, as during a network change. */
  readonly renewalOutageMs?: number;
  /** From the first lease renewal on, replies carry a Date ten minutes later, as after host sleep. */
  readonly hostSlept?: boolean;
  /** Called as the pull hands out the assignment. */
  readonly onAssignment?: () => void;
}

async function api(script: string, faults: Faults = {}, expiresAt = lease.expiresAt) {
  const directory = await createAutomationFixture({
    name: "client-proof",
    triggerLines: ["  type: webhook", "  path: /client"],
    mainJs: script,
  });
  const serverLease = { ...lease, expiresAt };
  const delivery = await createExecutionDelivery(serverLease, "run", {
    automationDirectory: directory,
    environmentName: "local",
    environment: { DECLARED: "value" },
  });
  let pulled = false;
  let pulls = 0;
  let serverClockAhead = 0;
  let renewals = 0;
  let failedRenewals = 0;
  let sources = 0;
  let startedAt: number | null = null;
  let accepted = false;
  const outputs: string[] = [];
  const reports: string[] = [];
  let tokenProbeStarted = () => {};
  const tokenProbe = new Promise<void>((resolve) => {
    tokenProbeStarted = resolve;
  });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/worker/heartbeat" && faults.stalledTokenRenewal) {
      tokenProbeStarted();
      return;
    }
    let body: unknown = { accepted: true };
    if (req.url === "/worker/preparations") body = { activeIds: [], deployments: [] };
    if (req.url === "/worker/run-images/keep") body = { keep: [] };
    if (req.url === "/worker/pull") {
      pulls++;
      if (!pulled) faults.onAssignment?.();
      body = { assignment: pulled ? null : delivery.assignment };
      pulled = true;
    }
    if (req.url === "/worker/source") {
      body = { files: delivery.source };
      if (++sources === 1 && faults.cutSource) {
        const text = JSON.stringify(body);
        res.writeHead(200, { "content-type": "application/json", "content-length": text.length });
        res.write(text.slice(0, text.length / 2));
        res.destroy();
        return;
      }
    }
    if (req.url === "/worker/start") {
      startedAt ??= Date.now();
      body = { secrets: delivery.secrets };
    }
    if (req.url === "/worker/lease/renew") {
      renewals++;
      if (faults.hostSlept) serverClockAhead = 10 * 60_000;
      if (faults.delayedRenewal && renewals > 1) await delay(700);
      if (
        startedAt !== null &&
        faults.renewalOutageMs !== undefined &&
        Date.now() - startedAt < faults.renewalOutageMs
      ) {
        failedRenewals++;
        res.statusCode = 503;
      }
      body = { lease: { ...serverLease, remainingMs: faults.delayedRenewal ? 500 : 3_000 } };
    }
    if (req.url === "/worker/output") {
      outputs.push(raw);
      if (outputs.length === 1) res.statusCode = 503;
    }
    if (req.url === "/worker/complete") {
      reports.push(raw);
      if (reports.length === 1) res.statusCode = 503;
      else accepted = true;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("date", new Date(Date.now() + serverClockAhead).toUTCString());
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No HTTP port");
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  vi.resetModules();
  const { startPlatformWorkerService } = await import("./worker-service.js");
  const credentialFile = path.join(await temporaryDirectory("swizzle-worker-auth-"), "worker.env");
  await writeFile(
    credentialFile,
    `SWIZZLE_WORKER_TOKEN=swz_${"a".repeat(43)}\nSWIZZLE_WORKER_TOKEN_EXPIRES_AT=${new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString()}\n`,
    { mode: 0o600 },
  );
  const worker = await startPlatformWorkerService({
    apiUrl: `http://127.0.0.1:${address.port}`,
    credential: faults.stalledTokenRenewal
      ? { kind: "file", path: credentialFile }
      : { kind: "configured", token: "test-token" },
    capabilities: {
      languages: [{ name: "node", version: "22.0.0" }],
      binaries: [],
      executionModes: ["host"],
      dependencyPackaging: { node: false, python: false },
    },
    concurrency: 1,
  });
  onTestFinished(() => worker.close());
  return {
    outputs,
    reports,
    tokenProbe,
    close: () => worker.close(),
    accepted: () => accepted,
    pulls: () => pulls,
    renewals: () => renewals,
    failedRenewals: () => failedRenewals,
    sources: () => sources,
  };
}

it.for(["1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"])(
  "uses monotonic validity with server expiry %s and retries identical replies",
  async (expiresAt, { signal }) => {
    const client = await api("console.log(JSON.stringify({ok:true}));", {}, expiresAt);
    await waitFor(signal, client.accepted);
    expect(client.outputs).toHaveLength(2);
    expect(client.outputs[1]).toBe(client.outputs[0]);
    // A request names its attempt by task and generation; the server reads the rest from its row.
    expect(JSON.parse(client.outputs[0] ?? "{}").lease).toEqual({
      taskId: lease.taskId,
      generation: lease.generation,
    });
    expect(client.reports).toHaveLength(2);
    expect(client.reports[1]).toBe(client.reports[0]);
  },
);

it("stops before server expiry when a renewal acknowledgement is delayed", async ({ signal }) => {
  const client = await api(
    "await new Promise(resolve=>setTimeout(resolve,2000)); console.log('{}');",
    { delayedRenewal: true },
  );
  await waitFor(signal, () => client.renewals() > 1);
  await delay(1000);
  expect(client.reports).toEqual([]);
  expect(client.outputs).toEqual([]);
});

it("fetches the bundle again after a transfer breaks off", async ({ signal }) => {
  const client = await api(
    "console.error('secret ' + process.env.DECLARED); console.log(JSON.stringify({ok:true}));",
    { cutSource: true },
  );
  await waitFor(signal, client.accepted);
  expect(client.sources()).toBe(2);
  expect(JSON.parse(client.reports[1] ?? "{}").report).toMatchObject({ exitCode: 0 });
  expect(client.outputs.join("")).toContain("secret value");
});

it("keeps running through renewal failures shorter than the lease", async ({ signal }) => {
  const client = await api(
    "await new Promise(resolve=>setTimeout(resolve,1500)); console.log(JSON.stringify({ok:true}));",
    { renewalOutageMs: 1_500 },
  );
  await waitFor(signal, client.accepted);
  expect(client.failedRenewals()).toBeGreaterThan(0);
  expect(JSON.parse(client.reports[1] ?? "{}").report).toMatchObject({ exitCode: 0 });
});

it("closes the worker while shared token renewal is stalled", async () => {
  const client = await api("console.log('{}');", { stalledTokenRenewal: true });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 84 * 24 * 60 * 60_000);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  await client.tokenProbe;
  expect(await Promise.race([client.close().then(() => true), delay(1000).then(() => false)])).toBe(
    true,
  );
});

it("takes no work after the host slept until it has stayed awake", async ({ signal }) => {
  const client = await api("console.log('{}');", { hostSlept: true });
  await waitFor(signal, () => client.renewals() > 0);
  const pulls = client.pulls();
  await delay(1_500);
  expect(client.sources()).toBe(0);
  expect(client.outputs).toEqual([]);
  expect(client.pulls()).toBe(pulls);
});

it("leaves an assignment unstarted when Docker stopped while the pull waited", async ({
  signal,
}) => {
  vi.stubEnv("SWIZZLE_REQUIRE_SANDBOX", "true");
  let dockerUp = true;
  vi.doMock("./container-runner.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./container-runner.js")>()),
    isDockerAvailable: async () => dockerUp,
  }));
  onTestFinished(() => {
    vi.doUnmock("./container-runner.js");
  });
  const client = await api("console.log('{}');", {
    onAssignment: () => {
      dockerUp = false;
    },
  });
  await waitFor(signal, () => client.renewals() > 0);
  expect(client.sources()).toBe(0);
  expect(client.outputs).toEqual([]);
});
