import type { ExecutionLease, WorkerIdentity } from "@swizzle/db";
import { ExecutionLeaseError } from "@swizzle/db";
import { expect, it, vi } from "vitest";
import type { ExecutionService } from "../packages/runtime/src/execution-service.js";
import { createExecutionDelivery } from "../packages/runtime/src/execution-wire.js";
import { createAutomationFixture } from "../packages/runtime/test/platform-harness.js";
import { executeTestAssignment } from "./execution.js";

const worker: WorkerIdentity = { id: "worker", credentialGeneration: 1 };
const lease: ExecutionLease = {
  taskId: "run",
  runId: "run",
  checkId: null,
  dueAt: null,
  workerId: worker.id,
  generation: 1,
  executionNumber: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  remainingMs: 90_000,
};

it.each(["output", "renewal"] as const)(
  "propagates an unexpected %s failure after stopping the process",
  async (request) => {
    const failure = new Error(`${request} database unavailable`);
    const executing = executeWithFailure(request, failure);
    await expect(executing).rejects.toBe(failure);
  },
);

it.each(["output", "renewal"] as const)(
  "accepts expected lease loss from %s after stopping the process",
  async (request) => {
    await expect(executeWithFailure(request, new ExecutionLeaseError())).resolves.toBeUndefined();
  },
);

async function executeWithFailure(request: "output" | "renewal", failure: Error) {
  const directory = await createAutomationFixture({
    name: "transport-failure",
    triggerLines: ["  type: webhook", "  path: /transport-failure"],
    mainJs: "process.stderr.write('started\\n');setInterval(() => {}, 100);",
  });
  const delivery = await createExecutionDelivery(lease, "run", {
    automationDirectory: directory,
    environmentName: "local",
  });
  const reject = vi.fn(async () => {
    throw failure;
  });
  const executions: ExecutionService = {
    prepare: async () => delivery.assignment,
    ready: async () => {},
    source: async () => delivery.source,
    start: async () => delivery.secrets,
    output: request === "output" ? reject : async () => {},
    complete: async () => {
      throw new ExecutionLeaseError();
    },
  };
  await executeTestAssignment(
    worker,
    executions,
    delivery.assignment,
    process.env,
    request === "renewal" ? reject : async () => {},
  );
  expect(reject).toHaveBeenCalled();
}
