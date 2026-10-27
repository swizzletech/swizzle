import { parseAutomationConfig } from "@swizzle/config";
import { expect, it } from "vitest";

import { assertDeploymentRuntimeReadiness } from "./deployment-admin.js";
import type { ReadinessWorker } from "./platform-records.js";

const NO_CAPABILITIES = {
  binaries: [],
  dependencyPackaging: { node: false, python: false },
  executionModes: [],
  languages: [],
} satisfies ReadinessWorker["capabilities"];

function worker(name: string, overrides: Partial<ReadinessWorker> = {}): ReadinessWorker {
  return {
    availability: "online",
    capabilities: NO_CAPABILITIES,
    concurrency: 1,
    instanceId: `${name}-id`,
    name,
    profiles: [{ name: "host-default", queueName: "platform-runs--host-default" }],
    services: [],
    ...overrides,
  };
}

it("names in words what each worker lacks when no worker can run the automation", () => {
  const config = parseAutomationConfig(`
name: transcode
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
runtime:
  language: python
  profile: gpu
  requirements:
    binaries:
      - name: ffmpeg
      - name: sox
`);
  const gpu = [{ name: "gpu", queueName: "platform-runs--gpu" }];
  const workers = [
    worker("gpu-box", {
      capabilities: {
        ...NO_CAPABILITIES,
        binaries: [{ name: "sox", version: null }],
        executionModes: ["host"],
        languages: [{ name: "node", version: "22.0.0" }],
      },
      profiles: gpu,
    }),
    worker("gpu-laptop", { availability: "offline", profiles: gpu }),
    worker("Local worker"),
  ];

  expect(() =>
    assertDeploymentRuntimeReadiness({ config, directory: process.cwd(), workers }),
  ).toThrow(
    /^No worker in group "gpu" meets every requirement\. Workers in group "gpu" here: gpu-box does not run python and lacks the binary ffmpeg\. gpu-laptop is offline, so it reports no languages or binaries\.$/u,
  );
});

it("names only the missing group when no worker is in it", () => {
  const config = parseAutomationConfig(`
name: transcode
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
runtime:
  language: node
  profile: gpu
`);

  expect(() =>
    assertDeploymentRuntimeReadiness({
      config,
      directory: process.cwd(),
      workers: [worker("Local worker")],
    }),
  ).toThrow(
    /^No worker serves group "gpu" here\. `swizzle worker groups` lists the groups that do; an owner or admin grants a worker a group\.$/u,
  );
});

it("refuses a service no worker of the group is granted, and deploys once one is", () => {
  const config = parseAutomationConfig(`
name: summarize
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
runtime:
  language: node
  permissions:
    network: true
    services: [local-llm]
`);
  const node = {
    ...NO_CAPABILITIES,
    executionModes: ["host"],
    languages: [{ name: "node", version: "22.0.0" }],
  } satisfies ReadinessWorker["capabilities"];
  const plain = worker("Local worker", { capabilities: node });

  expect(() =>
    assertDeploymentRuntimeReadiness({ config, directory: process.cwd(), workers: [plain] }),
  ).toThrow(
    /^No worker in group "host-default" meets every requirement\. Workers in group "host-default" here: Local worker is not granted the service local-llm\.$/u,
  );
  const granted = worker("gpu-box", { capabilities: node, services: ["local-llm"] });
  expect(() =>
    assertDeploymentRuntimeReadiness({
      config,
      directory: process.cwd(),
      workers: [plain, granted],
    }),
  ).not.toThrow();
});

it("names a worker whose binary is older than the automation requires", () => {
  const config = parseAutomationConfig(`
name: transcode
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
runtime:
  language: node
  requirements:
    binaries:
      - name: ffmpeg
        version: ">=6"
`);
  const workers = [
    worker("Local worker", {
      capabilities: {
        ...NO_CAPABILITIES,
        binaries: [{ name: "ffmpeg", version: "5.1.2" }],
        executionModes: ["host"],
        languages: [{ name: "node", version: "22.0.0" }],
      },
    }),
  ];

  expect(() =>
    assertDeploymentRuntimeReadiness({ config, directory: process.cwd(), workers }),
  ).toThrow(/ Local worker has ffmpeg 5\.1\.2 where >=6 is required\.$/u);
});

it("deploys when one worker of the group meets a binary version, in either worker order", () => {
  const config = parseAutomationConfig(`
name: transcode
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
runtime:
  language: node
  requirements:
    binaries:
      - name: ffmpeg
        version: ">=6.0.0"
`);
  const withFfmpeg = (host: string, version: string) =>
    worker(host, {
      capabilities: {
        ...NO_CAPABILITIES,
        binaries: [{ name: "ffmpeg", version }],
        executionModes: ["host"],
        languages: [{ name: "node", version: "22.0.0" }],
      },
    });
  const pool = [withFfmpeg("old-box", "4.4.0"), withFfmpeg("new-box", "6.1.0")];
  for (const workers of [pool, pool.toReversed()]) {
    expect(() =>
      assertDeploymentRuntimeReadiness({ config, directory: process.cwd(), workers }),
    ).not.toThrow();
  }

  const outdated = [withFfmpeg("old-box", "4.4.0"), withFfmpeg("mid-box", "5.1.0")];
  for (const workers of [outdated, outdated.toReversed()]) {
    expect(() =>
      assertDeploymentRuntimeReadiness({ config, directory: process.cwd(), workers }),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          /^(?=.*old-box has ffmpeg 4\.4\.0 where >=6\.0\.0 is required\.)(?=.*mid-box has ffmpeg 5\.1\.0 where >=6\.0\.0 is required\.)(?!.*meets the group)/u,
        ),
      }),
    );
  }
});
