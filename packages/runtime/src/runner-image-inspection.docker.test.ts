import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseAutomationConfig } from "@swizzle/config";
import { expect, it, vi } from "vitest";
import { heldDeadlines, temporaryDirectory } from "../../../test/support.js";
import { createRunnerImageChecks } from "./runner-image-checks.js";
import { inspectRunnerImage } from "./runner-image-inspection.js";
import { evaluateAutomationReadiness } from "./runtime-requirements.js";

it("keeps a custom image without a tool record ready with unverified requirements", async ({
  signal,
}) => {
  heldDeadlines();
  const directory = await temporaryDirectory("swizzle-image-no-record-");
  const image = `swizzle-image-no-record:${randomUUID()}`;
  const exec = promisify(execFile);
  await writeFile(path.join(directory, "marker"), "legacy image\n");
  await writeFile(path.join(directory, "Dockerfile"), "FROM scratch\nCOPY marker /marker\n");
  await exec("docker", ["build", "--tag", image, directory], { signal });
  const checks = createRunnerImageChecks();
  try {
    const config = parseAutomationConfig(`
name: legacy-image
version: 1.0.0
entrypoint: main.js
trigger: { type: webhook }
runtime:
  execution_mode: container
  container: { base_image: ${image} }
  requirements:
    binaries: [{ name: legacy-tool, version: '>=7' }]
`);
    const pending = checks.workers(config.runtime, [
      {
        availability: "online",
        instanceId: "legacy-worker",
        name: "worker",
        concurrency: 1,
        profiles: [{ name: "host-default", queueName: "platform-runs--host-default" }],
        services: [],
        capabilities: {
          binaries: [{ name: "legacy-tool", version: "1" }],
          languages: [{ name: "python", version: "3.13.5" }],
          executionModes: ["container"],
          dependencyPackaging: { node: false, python: false },
        },
      },
    ]);
    const requests = checks.exchange("legacy-worker", []);
    for (const request of requests) {
      checks.exchange("legacy-worker", [await inspectRunnerImage(request)]);
    }
    const readiness = evaluateAutomationReadiness({ config, directory }, await pending);
    expect(readiness).toMatchObject({
      status: "ready",
      errors: [],
      compatibleWorkerInstanceIds: ["legacy-worker"],
      warnings: [
        {
          code: "RUNNER_IMAGE_REQUIREMENTS_UNVERIFIED",
          message: expect.stringContaining("language node and binaries legacy-tool >=7"),
          subject: "runtime.container.base_image",
          worker: "worker",
        },
      ],
    });
    expect(JSON.stringify(readiness)).toContain("/etc/swizzle/runner-tools.json");
    expect(JSON.stringify(readiness)).toContain("infra/docker/runner-tools.mjs");
    const [selected] = await pending;
    expect(selected?.runnerImage).toEqual({ kind: "unverified" });
  } finally {
    checks.close();
    await exec("docker", ["image", "rm", image]);
  }
});

it("keeps a missing image unavailable", async () => {
  heldDeadlines();
  const report = await inspectRunnerImage({
    id: "absent-image",
    image: `sha256:${"0".repeat(64)}`,
  });
  expect(report).toMatchObject({
    id: "absent-image",
    result: { kind: "unavailable", message: expect.stringContaining("No such image") },
  });
});

it("keeps a Docker connection error unavailable", async () => {
  heldDeadlines();
  const directory = await temporaryDirectory("swizzle-no-daemon-");
  vi.stubEnv("DOCKER_HOST", `unix://${directory}/absent.sock`);
  const report = await inspectRunnerImage({ id: "docker-error", image: "custom:legacy" });
  expect(report).toMatchObject({
    id: "docker-error",
    result: { kind: "unavailable", message: expect.stringContaining("absent.sock") },
  });
});

it("reads the selected image's inventory without starting its entrypoint", async ({ signal }) => {
  heldDeadlines();
  const directory = await temporaryDirectory("swizzle-image-record-");
  const image = `swizzle-image-record:${randomUUID()}`;
  const exec = promisify(execFile);
  await writeFile(
    path.join(directory, "runner-tools.json"),
    JSON.stringify({
      languages: [
        { name: "node", version: "26.12.1" },
        { name: "typescript", version: "26.12.1" },
      ],
      dependencyPackaging: { node: false, python: false },
      binaries: [
        { name: "image-only", version: "7.2" },
        { name: "node", version: "26.12.1" },
      ],
    }),
  );
  // The image need not even contain a runnable entrypoint to have a readable build record.
  await writeFile(
    path.join(directory, "Dockerfile"),
    'FROM scratch\nCOPY runner-tools.json /etc/swizzle/runner-tools.json\nENTRYPOINT ["/never-execute"]\n',
  );
  await exec("docker", ["build", "--tag", image, directory], { signal });
  try {
    expect(await inspectRunnerImage({ id: "record-probe", image })).toMatchObject({
      id: "record-probe",
      result: {
        kind: "ready",
        capabilities: {
          binaries: [
            { name: "image-only", version: "7.2" },
            { name: "node", version: "26.12.1" },
          ],
          languages: [
            { name: "node", version: "26.12.1" },
            { name: "typescript", version: "26.12.1" },
          ],
          dependencyPackaging: { node: false, python: false },
        },
      },
    });
  } finally {
    await exec("docker", ["image", "rm", image]);
  }
});
