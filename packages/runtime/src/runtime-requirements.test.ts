import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseAutomationConfig } from "@swizzle/config";
import { describe, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import type { ReadinessWorker } from "./platform-records.js";
import {
  collectWorkerCapabilities,
  createQueueNameForProfile,
  createRuntimeSnapshot,
  evaluateAutomationReadiness,
  evaluateLocalAutomationReadiness,
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
  it("derives runner languages and packaging from its inventory instead of the worker host", async () => {
    const capabilities = await collectWorkerCapabilities({
      binaries: [
        { name: "node", version: "26.12.1" },
        { name: "python3", version: "3.13.5" },
        { name: "pip", version: "25.1" },
      ],
      languages: [
        { name: "python", version: "3.13.5" },
        { name: "node", version: "26.12.1" },
      ],
      dependencyPackaging: { node: false, python: true },
    });
    expect(capabilities).toMatchObject({
      dependencyPackaging: { node: false, python: true },
      languages: expect.arrayContaining([{ name: "python", version: "3.13.5" }]),
    });
    expect(capabilities.binaries.find((binary) => binary.name === "npm")).toBeUndefined();
  });

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

describe("evaluateLocalAutomationReadiness", () => {
  it("finds a declared binary on PATH and its version without assuming --version", async () => {
    // pdftoppm answers --version with exit 99 and prints its version only for -v.
    const bin = await temporaryDirectory("swizzle-path-");
    await writeFile(
      path.join(bin, "pdftoppm"),
      '#!/bin/sh\nif [ "$1" = "-v" ]; then echo "pdftoppm version 25.03.0" >&2; exit 0; fi\nexit 99\n',
    );
    await chmod(path.join(bin, "pdftoppm"), 0o755);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    const readiness = (binaries: string) =>
      evaluateLocalAutomationReadiness({
        config: config(`  requirements:\n    binaries:\n${binaries}`),
        directory: process.cwd(),
      });

    expect(await readiness('      - name: pdftoppm\n        version: ">=25"')).toMatchObject({
      errors: [],
      status: "ready",
    });
    expect(await readiness('      - name: pdftoppm\n        version: "25"')).toMatchObject({
      errors: [],
      status: "ready",
    });
    expect(await readiness('      - name: pdftoppm\n        version: ">=26"')).toMatchObject({
      errors: [
        {
          code: "BINARY_VERSION_UNSUPPORTED",
          message: "This machine has pdftoppm 25.03.0 where >=26 is required.",
        },
      ],
    });
    // A binary that prints no version passes a bare declaration but no version rule.
    await writeFile(path.join(bin, "swizzle-quiet"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, "swizzle-quiet"), 0o755);
    expect(await readiness("      - name: swizzle-quiet")).toMatchObject({ status: "ready" });
    expect(await readiness('      - name: swizzle-quiet\n        version: ">=1"')).toMatchObject({
      errors: [
        {
          code: "BINARY_VERSION_UNSUPPORTED",
          message:
            "This machine has swizzle-quiet in a version it cannot tell where >=1 is required.",
        },
      ],
    });
    expect(await readiness("      - name: swizzle-absent-binary")).toMatchObject({
      errors: [
        {
          code: "BINARY_REQUIREMENT_MISSING",
          message: "This machine lacks the binary swizzle-absent-binary.",
        },
      ],
    });
  });
});

describe("evaluateAutomationReadiness", () => {
  it.each([
    [">=7", null, "not-ready"],
    ["latest", "25.3", "ready"],
    ["latest", null, "not-ready"],
    ["25", "25.3", "not-ready"],
    ["25", "25.03.0", "not-ready"],
    ["25", "25.0.0", "ready"],
    ["v25.03.0", "25.3", "ready"],
  ])("preserves saved rule %s against worker version %s as %s", (rule, version, status) => {
    const saved = parseAutomationConfig(
      `
name: saved
version: 1.0.0
entrypoint: main.js
trigger: { type: webhook }
runtime:
  requirements:
    binaries: [{ name: pdftoppm, version: '${rule}' }]
`,
      "deployment",
    );
    const available = worker(["host"]);
    const pdfWorker = {
      ...available,
      capabilities: { ...available.capabilities, binaries: [{ name: "pdftoppm", version }] },
    };
    expect(
      evaluateAutomationReadiness({ config: saved, directory: process.cwd() }, [pdfWorker]),
    ).toMatchObject({ status });
  });

  it.each([
    ["25", "ready"],
    ["25.3", "ready"],
    ["25.03.0", "ready"],
    ["2", "not-ready"],
    ["25.4", "not-ready"],
    ["=25", "not-ready"],
    ["=25.3.0", "ready"],
    [">=26", "not-ready"],
    ["<=25", "not-ready"],
    ["<26", "ready"],
    [">25", "ready"],
  ])("checks rule %s against a worker's pdftoppm 25.03.0 as %s", (rule, status) => {
    const available = worker(["host"]);
    const pdfWorker = {
      ...available,
      capabilities: {
        ...available.capabilities,
        binaries: [{ name: "pdftoppm", version: "25.03.0" }],
      },
    };
    expect(
      evaluateAutomationReadiness(
        {
          config: config(
            `  requirements:\n    binaries:\n      - name: pdftoppm\n        version: "${rule}"`,
          ),
          directory: process.cwd(),
        },
        [pdfWorker],
      ),
    ).toMatchObject({ status });
    const current = config(
      `  requirements:\n    binaries:\n      - name: pdftoppm\n        version: "${rule}"`,
    );
    const reloaded = parseAutomationConfig(JSON.stringify(current), "deployment");
    expect(
      evaluateAutomationReadiness({ config: reloaded, directory: process.cwd() }, [pdfWorker]),
    ).toMatchObject({ status });
    expect(createRuntimeSnapshot(reloaded).binary_version_matching).toBe("numeric-prefix");
  });

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
