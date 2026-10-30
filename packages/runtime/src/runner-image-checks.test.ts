import { parseAutomationConfig } from "@swizzle/config";
import { expect, it } from "vitest";
import type { ReadinessWorker } from "./platform-records.js";
import { createRunnerImageChecks } from "./runner-image-checks.js";
import { evaluateAutomationReadiness } from "./runtime-requirements.js";

function nodeWorker(instanceId: string): ReadinessWorker {
  return {
    availability: "online",
    instanceId,
    name: "worker",
    concurrency: 1,
    profiles: [{ name: "host-default", queueName: "platform-runs--host-default" }],
    services: [],
    capabilities: {
      binaries: [{ name: "default-tool", version: "9" }],
      languages: [{ name: "node", version: "26.12.1" }],
      executionModes: ["container"],
      dependencyPackaging: { node: false, python: false },
    },
  };
}

it("expires one readiness caller without shortening a shared deployment inspection", async () => {
  const checks = createRunnerImageChecks();
  const config = parseAutomationConfig(`
name: deadline-probe
version: 1.0.0
entrypoint: main.js
trigger: { type: webhook }
runtime:
  execution_mode: container
  container: { base_image: custom:slow }
`);
  const worker = nodeWorker("worker-1");
  const deadline = new AbortController();
  try {
    const short = checks.workers(config.runtime, [worker], deadline.signal);
    const deployment = checks.workers(config.runtime, [worker]);
    const [request] = checks.exchange(worker.instanceId, []);
    expect(request).toEqual({ id: expect.any(String), image: "custom:slow" });
    deadline.abort();
    // The worker reports only after the read caller's deadline; the deployment still waits for it.
    checks.exchange(worker.instanceId, [
      {
        id: request?.id ?? "missing",
        result: {
          kind: "ready",
          capabilities: worker.capabilities,
        },
      },
    ]);
    expect(
      evaluateAutomationReadiness({ config, directory: process.cwd() }, await short),
    ).toMatchObject({
      status: "not-ready",
      errors: [
        {
          code: "RUNNER_IMAGE_INVENTORY_UNAVAILABLE",
          message: expect.stringContaining("response deadline"),
        },
      ],
    });
    expect(
      evaluateAutomationReadiness({ config, directory: process.cwd() }, await deployment),
    ).toMatchObject({
      status: "ready",
      errors: [],
      compatibleWorkerInstanceIds: ["worker-1"],
    });
  } finally {
    checks.close();
  }
});

it("checks the selected base image instead of the default image's opposite binary inventory", async () => {
  const checks = createRunnerImageChecks();
  const config = parseAutomationConfig(`
name: image-probe
version: 1.0.0
entrypoint: main.js
trigger: { type: webhook }
runtime:
  execution_mode: container
  container: { base_image: custom:reviewed }
  requirements:
    binaries: [{ name: custom-tool, version: ">=7" }]
`);
  const worker = nodeWorker("worker-1");
  try {
    const pending = checks.workers(config.runtime, [worker]);
    const request = checks.exchange("worker-1", []);
    expect(request).toEqual([{ id: expect.any(String), image: "custom:reviewed" }]);
    const id = request[0]?.id ?? "missing";
    // A different worker cannot answer this worker's request.
    expect(
      checks.exchange("worker-2", [
        { id, result: { kind: "unavailable", message: "wrong worker" } },
      ]),
    ).toEqual([]);
    checks.exchange("worker-1", [
      {
        id,
        result: {
          kind: "ready",
          capabilities: {
            ...worker.capabilities,
            binaries: [{ name: "custom-tool", version: "7.2" }],
          },
        },
      },
    ]);
    const selected = await pending;
    expect(
      evaluateAutomationReadiness({ config, directory: process.cwd() }, selected),
    ).toMatchObject({ status: "ready", compatibleWorkerInstanceIds: ["worker-1"] });
    const needsDefault = {
      ...config,
      runtime: {
        ...config.runtime,
        requirements: { ...config.runtime.requirements, binaries: [{ name: "default-tool" }] },
      },
    };
    expect(
      evaluateAutomationReadiness({ config: needsDefault, directory: process.cwd() }, selected),
    ).toMatchObject({
      status: "not-ready",
      errors: [
        expect.objectContaining({ code: "BINARY_REQUIREMENT_MISSING", subject: "default-tool" }),
      ],
    });
    expect(worker.capabilities.binaries).toEqual([{ name: "default-tool", version: "9" }]);
    const mixed = checks.workers(config.runtime, [worker, { ...worker, instanceId: "worker-2" }]);
    const first = checks.exchange("worker-1", [])[0];
    const second = checks.exchange("worker-2", [])[0];
    expect(first?.image).toBe("custom:reviewed");
    expect(second?.image).toBe("custom:reviewed");
    checks.exchange("worker-1", [
      {
        id: first?.id ?? "missing",
        result: {
          kind: "ready",
          capabilities: {
            ...worker.capabilities,
            binaries: [{ name: "custom-tool", version: "7.2" }],
          },
        },
      },
    ]);
    checks.exchange("worker-2", [
      {
        id: second?.id ?? "missing",
        result: { kind: "unavailable", message: "inventory missing" },
      },
    ]);
    const snapshots = await mixed;
    expect(
      evaluateAutomationReadiness({ config, directory: process.cwd() }, snapshots),
    ).toMatchObject({
      status: "ready",
      compatibleWorkerInstanceIds: ["worker-1"],
    });
    expect(
      evaluateAutomationReadiness(
        { config, directory: process.cwd() },
        snapshots.filter((snapshot) => snapshot.instanceId === "worker-2"),
      ),
    ).toMatchObject({
      status: "not-ready",
      errors: [expect.objectContaining({ code: "RUNNER_IMAGE_INVENTORY_UNAVAILABLE" })],
    });
  } finally {
    checks.close();
  }
});

it.each([
  { defaultLanguage: "node", imageLanguage: "python", status: "ready" },
  { defaultLanguage: "python", imageLanguage: "node", status: "not-ready" },
] as const)(
  "uses a custom image's language without explicit binaries ($status)",
  async ({ defaultLanguage, imageLanguage, status }) => {
    const checks = createRunnerImageChecks();
    const config = parseAutomationConfig(`
name: language-probe
version: 1.0.0
entrypoint: main.py
trigger: { type: webhook }
runtime:
  execution_mode: container
  container: { base_image: custom:python }
`);
    const worker = nodeWorker("worker-1");
    const defaultWorker = {
      ...worker,
      capabilities: {
        ...worker.capabilities,
        languages: [{ name: defaultLanguage, version: "3.13.5" }],
      },
    };
    try {
      const pending = checks.workers(config.runtime, [defaultWorker]);
      const requests = checks.exchange(worker.instanceId, []);
      expect(requests).toEqual([{ id: expect.any(String), image: "custom:python" }]);
      for (const request of requests)
        checks.exchange(worker.instanceId, [
          {
            id: request.id,
            result: {
              kind: "ready",
              capabilities: {
                ...worker.capabilities,
                languages: [{ name: imageLanguage, version: "3.13.5" }],
              },
            },
          },
        ]);
      expect(
        evaluateAutomationReadiness({ config, directory: process.cwd() }, await pending),
      ).toMatchObject({ status });
    } finally {
      checks.close();
    }
  },
);

it("checks the only compatible worker beyond the first 64 eligible workers", async () => {
  const checks = createRunnerImageChecks();
  const config = parseAutomationConfig(`
name: fleet-probe
version: 1.0.0
entrypoint: main.js
trigger: { type: webhook }
runtime:
  execution_mode: container
  container: { base_image: custom:reviewed }
  requirements:
    binaries: [{ name: custom-tool }]
`);
  const workers = Array.from({ length: 65 }, (_, i) => nodeWorker(`worker-${i + 1}`));
  try {
    const pending = checks.workers(config.runtime, workers);
    for (const worker of workers) {
      for (const request of checks.exchange(worker.instanceId, []))
        checks.exchange(worker.instanceId, [
          {
            id: request.id,
            result: {
              kind: "ready",
              capabilities: {
                ...worker.capabilities,
                binaries:
                  worker.instanceId === "worker-65"
                    ? [{ name: "custom-tool", version: "7.2" }]
                    : [],
              },
            },
          },
        ]);
    }
    expect(
      evaluateAutomationReadiness({ config, directory: process.cwd() }, await pending),
    ).toMatchObject({ status: "ready", compatibleWorkerInstanceIds: ["worker-65"] });
  } finally {
    checks.close();
  }
});

it("shares one inspection across concurrent checks of the same worker and image", async () => {
  const checks = createRunnerImageChecks();
  const config = parseAutomationConfig(`
name: concurrent-probe
version: 1.0.0
entrypoint: main.js
trigger: { type: webhook }
runtime:
  execution_mode: container
  container: { base_image: custom:reviewed }
  requirements:
    binaries: [{ name: custom-tool }]
`);
  const worker = nodeWorker("worker-1");
  try {
    const first = checks.workers(config.runtime, [worker]);
    const second = checks.workers(config.runtime, [worker]);
    const requests = checks.exchange(worker.instanceId, []);
    expect(requests).toEqual([{ id: expect.any(String), image: "custom:reviewed" }]);
    for (const request of requests)
      checks.exchange(worker.instanceId, [
        {
          id: request.id,
          result: {
            kind: "ready",
            capabilities: {
              ...worker.capabilities,
              binaries: [{ name: "custom-tool", version: "7.2" }],
            },
          },
        },
      ]);
    for (const snapshot of await Promise.all([first, second]))
      expect(
        evaluateAutomationReadiness({ config, directory: process.cwd() }, snapshot),
      ).toMatchObject({ status: "ready" });
  } finally {
    checks.close();
  }
});
