import { parseAutomationConfig } from "@swizzle/config";
import { describe, expect, it } from "vitest";
import type { ReadinessWorker } from "./platform-records.js";
import {
  collectWorkerCapabilities,
  createQueueNameForProfile,
  evaluateAutomationReadiness,
} from "./runtime-requirements.js";

function worker(executionModes: ReadinessWorker["capabilities"]["executionModes"]) {
  return {
    availability: "online",
    capabilities: {
      binaries: [],
      dependencyPackaging: { node: true, python: true },
      executionModes,
      languages: [
        { name: "node", version: "22.0.0" },
        { name: "python", version: "3.12.0" },
      ],
    },
    concurrency: 1,
    instanceId: "worker-1",
    name: "test-host",
    profiles: [{ name: "host-default", queueName: "platform-runs--host-default" }],
    services: [],
  } satisfies ReadinessWorker;
}

function config(runtime: string) {
  return parseAutomationConfig(`
name: demo
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
runtime:
${runtime}
`);
}

describe("createQueueNameForProfile", () => {
  it("strips the separators BullMQ rejects from profile names", () => {
    expect(createQueueNameForProfile("OCR: Tools / EU")).toBe("platform-runs--ocr-tools-eu");
  });
});

describe("collectWorkerCapabilities", () => {
  it("advertises node packaging without extra worker config", async () => {
    const capabilities = await collectWorkerCapabilities([]);

    expect(capabilities.binaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "node" }),
        expect.objectContaining({ name: "npm" }),
      ]),
    );
  });
});

describe("evaluateAutomationReadiness", () => {
  it("needs a worker that advertises container execution for a container automation", () => {
    const automation = { config: config("  execution_mode: container"), directory: process.cwd() };

    expect(evaluateAutomationReadiness(automation, [worker(["host", "profile"])])).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "CONTAINER_DOCKER_UNAVAILABLE" }),
      ]),
      status: "not-ready",
    });
    expect(evaluateAutomationReadiness(automation, [worker(["container"])])).toMatchObject({
      compatibleWorkerInstanceIds: ["worker-1"],
      status: "ready",
    });
  });

  it("rejects container memory or CPUs above the platform maximum", () => {
    const environment = { SWIZZLE_MAX_RUN_CPUS: "2", SWIZZLE_MAX_RUN_MEMORY_MB: "2048" };
    const readiness = (container: string) =>
      evaluateAutomationReadiness(
        { config: config(`  container:\n${container}`), directory: process.cwd() },
        [worker(["host"])],
        { environment },
      );

    expect(readiness('    memory_mb: 4096\n    cpus: "8"')).toMatchObject({
      errors: [
        {
          code: "RUNTIME_CONTAINER_LIMIT_EXCEEDS_MAX",
          message:
            "runtime.container.memory_mb 4096 exceeds the platform maximum of 2048 MiB set by SWIZZLE_MAX_RUN_MEMORY_MB.",
          subject: "runtime.container.memory_mb",
        },
        {
          code: "RUNTIME_CONTAINER_LIMIT_EXCEEDS_MAX",
          message:
            "runtime.container.cpus 8 exceeds the platform maximum of 2 CPUs set by SWIZZLE_MAX_RUN_CPUS.",
          subject: "runtime.container.cpus",
        },
      ],
      status: "not-ready",
    });
    expect(readiness('    memory_mb: 2048\n    cpus: "2"')).toMatchObject({
      errors: [],
      status: "ready",
    });
  });

  it("rejects a timeout above the platform ceiling unless a grant raises it", () => {
    const automation = { config: config("  timeout: 2h"), directory: process.cwd() };
    const environment = { SWIZZLE_MAX_RUN_TIMEOUT: "1h" };

    expect(
      evaluateAutomationReadiness(automation, [worker(["host"])], { environment }),
    ).toMatchObject({
      errors: [expect.objectContaining({ code: "RUNTIME_TIMEOUT_EXCEEDS_MAX" })],
      status: "not-ready",
    });
    expect(
      evaluateAutomationReadiness(automation, [worker(["host"])], {
        environment,
        grantMaxTimeoutMs: 3 * 3_600_000,
      }),
    ).toMatchObject({ errors: [], status: "ready" });
  });
});
