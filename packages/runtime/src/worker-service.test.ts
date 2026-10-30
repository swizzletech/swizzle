import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
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
  /** The lease lasts 500 ms, and renewals after the first get no reply while the test runs. */
  readonly heldRenewal?: boolean;
  /** The first source reply stops halfway through its body. */
  readonly cutSource?: boolean;
  /**
   * The first renewal after the attempt starts answers 503, as during a network change. The
   * automation's request to `GATE` gets its reply once a later renewal succeeded.
   */
  readonly refusedRenewal?: boolean;
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
  let pulled = false;
  let serverClockAhead = 0;
  let renewals = 0;
  let failedRenewals = 0;
  let sources = 0;
  let started = false;
  let accepted = false;
  const outputs: string[] = [];
  const reports: string[] = [];
  let finishTest = () => {};
  const testFinished = new Promise<void>((resolve) => {
    finishTest = resolve;
  });
  onTestFinished(() => finishTest());
  let renewalSucceeded = () => {};
  const renewedAfterRefusal = new Promise<void>((resolve) => {
    renewalSucceeded = resolve;
  });
  // The first time the worker gives up an execution or a pull, as it logs it.
  let failed = (_error: Error) => {};
  const failure = new Promise<Error>((resolve) => {
    failed = resolve;
  });
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
    if (req.url === "/worker/image-checks") body = { requests: [] };
    if (req.url === "/worker/preparations") body = { activeIds: [], deployments: [] };
    if (req.url === "/worker/run-images/keep") body = { keep: [] };
    if (req.url === "/worker/pull") {
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
    if (req.url === "/gate") {
      await renewedAfterRefusal;
      res.end();
      return;
    }
    if (req.url === "/worker/start") {
      started = true;
      body = { secrets: delivery.secrets };
    }
    if (req.url === "/worker/lease/renew") {
      renewals++;
      if (faults.hostSlept) serverClockAhead = 10 * 60_000;
      if (faults.heldRenewal && renewals > 1) await testFinished;
      if (faults.refusedRenewal && started && failedRenewals === 0) {
        failedRenewals++;
        res.statusCode = 503;
      } else if (failedRenewals > 0) renewalSucceeded();
      body = { lease: { ...serverLease, remainingMs: faults.heldRenewal ? 500 : 3_000 } };
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
  const delivery = await createExecutionDelivery(serverLease, "run", {
    automationDirectory: directory,
    environmentName: "local",
    environment: { DECLARED: "value", GATE: `http://127.0.0.1:${address.port}/gate` },
  });
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
    logger: {
      debug() {},
      info() {},
      error() {},
      warn(fields: { error?: Error }, message: string) {
        if (message === "Worker request failed; retrying." && fields.error) failed(fields.error);
      },
    },
  });
  onTestFinished(() => worker.close());
  return {
    outputs,
    reports,
    tokenProbe,
    failure,
    close: () => worker.close(),
    accepted: () => accepted,
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

it("stops before server expiry when a renewal acknowledgement is delayed", async () => {
  // The automation never ends by itself, so only the worker's local deadline stops it.
  const client = await api("setInterval(() => {}, 60_000);", { heldRenewal: true });
  expect((await client.failure).message).toBe("Execution lease was lost.");
  expect(client.renewals()).toBeGreaterThan(1);
  expect(client.reports).toEqual([]);
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
    "await fetch(process.env.GATE); console.log(JSON.stringify({ok:true}));",
    { refusedRenewal: true },
  );
  await waitFor(signal, client.accepted);
  expect(client.failedRenewals()).toBe(1);
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
  // The probe is still held, so close returns only when it stops waiting for it.
  await client.close();
});

// wake-gate.test.ts proves how long the worker then stays closed.
it("takes no work after the host slept until it has stayed awake", async () => {
  const client = await api("console.log('{}');", { hostSlept: true });
  expect((await client.failure).message).toBe("Host was asleep; leaving the assignment unstarted.");
  expect(client.sources()).toBe(0);
  expect(client.outputs).toEqual([]);
});

it("leaves an assignment unstarted when Docker stopped while the pull waited", async () => {
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
  expect((await client.failure).message).toBe(
    "Docker broker unavailable; leaving the assignment unstarted.",
  );
  expect(client.sources()).toBe(0);
  expect(client.outputs).toEqual([]);
});
