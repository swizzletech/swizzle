import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExecutionLease } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";
import { createAutomationFixture } from "../test/platform-harness.js";
import { localExecutionProtocol } from "./execution-protocol.js";
import {
  acceptExecutionReport,
  createExecutionDelivery,
  type ExecutionChannel,
  type ExecutionDelivery,
  executeAssignment,
  readExecutionSource,
  withExecutionSource,
} from "./execution-wire.js";

const lease: ExecutionLease = {
  taskId: "run",
  runId: "run",
  checkId: null,
  dueAt: null,
  workerId: "worker",
  generation: 1,
  executionNumber: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  remainingMs: 90_000,
};

/** The server's record of the attempt a report answers. */
const attempt = { payload: {}, runId: "run" };

/** The channel a worker would open over HTTP, served from the server's delivery. */
const channel = (delivery: ExecutionDelivery, start = vi.fn()): ExecutionChannel => ({
  ready: async () => {},
  source: async () => delivery.source,
  start: async () => {
    start();
    return delivery.secrets;
  },
  output: async () => {},
});

it("executes a transferred source and derives its JSON on the server", async () => {
  const directory = await createAutomationFixture({
    name: "wire-proof",
    triggerLines: ["  type: webhook", "  path: /wire-proof"],
    mainJs:
      "console.log(JSON.stringify({ answer: 42, declared: process.env.DECLARED, token: !!process.env.SWIZZLE_WORKER_TOKEN }));",
  });
  const options = {
    automationDirectory: directory,
    environmentName: "local",
    environment: { DECLARED: "allowed" },
  };
  const delivery = await createExecutionDelivery(lease, "run", options);
  expect(JSON.stringify(delivery.assignment)).not.toContain("allowed");
  const report = await executeAssignment({
    assignment: delivery.assignment,
    channel: channel(delivery),
    executor: localExecutionProtocol,
    environment: { ...process.env, SWIZZLE_WORKER_TOKEN: "not-for-the-script" },
    signal: new AbortController().signal,
  });
  expect(acceptExecutionReport(report, attempt)).toMatchObject({
    success: true,
    result: { answer: 42, declared: "allowed", token: false },
  });
  expect(acceptExecutionReport({ ...report, stdout: "not JSON" }, attempt)).toMatchObject({
    success: false,
    code: "PROCESS_STDOUT_INVALID_JSON",
  });
  expect(
    acceptExecutionReport(
      {
        ...report,
        exitCode: null,
        failure: { code: "PLATFORM_CONFIG_INVALID", message: "Invalid policy", signal: null },
      },
      attempt,
    ),
  ).toMatchObject({
    success: false,
    code: "PLATFORM_CONFIG_INVALID",
    message: "Invalid policy",
  });
  expect(
    acceptExecutionReport(
      {
        ...report,
        exitCode: null,
        failure: {
          code: "PROCESS_SIGNAL",
          message: "Terminated",
          signal: "SIGTERM",
          cause: "cause",
          stack: "trace",
        },
        phases: { image: 12, process: 34 },
      },
      attempt,
    ),
  ).toMatchObject({
    success: false,
    code: "PROCESS_SIGNAL",
    signal: "SIGTERM",
    cause: "cause",
    stack: "trace",
    phases: { image: 12, process: 34 },
  });
});

describe("source transfer", () => {
  it("retains content and rejects paths or content changed in transit", async () => {
    const source = await createAutomationFixture({
      name: "source-proof",
      triggerLines: ["  type: webhook", "  path: /source-proof"],
      mainJs: "console.log('{}');",
    });
    const files = await readExecutionSource(source);
    await withExecutionSource(files, async (directory) => {
      expect(await readFile(path.join(directory, "main.js"), "utf8")).toBe("console.log('{}');");
      expect((await stat(path.join(directory, "main.js"))).mode & 0o077).toBe(0);
    });
    const use = async () => {
      throw new Error("Unsafe source reached execution");
    };
    await expect(
      withExecutionSource(
        files.map((file) => ({ ...file, path: `../${file.path}` })),
        use,
      ),
    ).rejects.toThrow("Invalid execution source path");
    await expect(
      withExecutionSource(
        files.map((file) => ({ ...file, data: Buffer.from("tampered").toString("base64") })),
        use,
      ),
    ).rejects.toThrow("digest mismatch");
  });
});

it("round-trips an upstream contract failure from the real executor", async () => {
  const directory = await createAutomationFixture({
    name: "contract-wire",
    triggerLines: ["  type: webhook", "  path: /contract"],
    mainJs: `console.error(JSON.stringify({type:'contract_changed',api:'api.example.com',field:'amount',expected:'number',got:'string'}));process.exit(1);`,
  });
  const options = { automationDirectory: directory, environmentName: "local" };
  const delivery = await createExecutionDelivery(lease, "run", options);
  const report = await executeAssignment({
    assignment: delivery.assignment,
    channel: channel(delivery),
    executor: localExecutionProtocol,
    environment: process.env,
    signal: new AbortController().signal,
  });
  expect(report.failure?.code).toBe("UPSTREAM_CONTRACT_CHANGED");
  expect(acceptExecutionReport(report, attempt)).toMatchObject({
    success: false,
    code: "UPSTREAM_CONTRACT_CHANGED",
  });
});
it("preserves missing required secrets from an executor report", () => {
  expect(
    acceptExecutionReport(
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        failure: { code: "MISSING_REQUIRED_SECRETS", message: "executor failure", signal: null },
      },
      attempt,
    ),
  ).toMatchObject({ success: false, code: "MISSING_REQUIRED_SECRETS" });
});
it("does not invoke an executor when staging loses ownership", async () => {
  const directory = await createAutomationFixture({
    name: "aborted-wire",
    triggerLines: ["  type: webhook", "  path: /abort"],
    mainJs: "console.log('{}');",
  });
  const delivery = await createExecutionDelivery(lease, "run", {
    automationDirectory: directory,
    environmentName: "local",
  });
  const abort = new AbortController();
  const run = vi.fn();
  const executing = executeAssignment({
    assignment: delivery.assignment,
    channel: channel(delivery),
    executor: { run, check: run },
    environment: process.env,
    signal: abort.signal,
  });
  // executeAssignment has entered asynchronous filesystem staging, before the executor.
  abort.abort(new Error("lease expired during staging"));
  await expect(executing).rejects.toThrow("lease expired during staging");
  expect(run).not.toHaveBeenCalled();
});
it("refuses a bundle other than the assigned one before the attempt starts", async () => {
  const assigned = await createExecutionDelivery(lease, "run", {
    automationDirectory: await createAutomationFixture({
      name: "assigned-wire",
      triggerLines: ["  type: webhook", "  path: /assigned"],
      mainJs: "console.log('{}');",
    }),
    environmentName: "local",
    environment: { DECLARED: "secret" },
  });
  const other = await readExecutionSource(
    await createAutomationFixture({
      name: "other-wire",
      triggerLines: ["  type: webhook", "  path: /other"],
      mainJs: "console.log('{}');",
    }),
  );
  const start = vi.fn();
  const run = vi.fn();
  await expect(
    executeAssignment({
      assignment: assigned.assignment,
      channel: { ...channel(assigned, start), source: async () => other },
      executor: { run, check: run },
      environment: process.env,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("does not match its assignment");
  expect(start).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
