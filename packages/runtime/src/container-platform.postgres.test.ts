import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { TEST_ENCRYPTION_KEY, temporaryDirectory, waitFor } from "../../../test/support.js";
import { fakeDocker } from "../test/container-docker.js";
import { createAutomationFixture } from "../test/platform-harness.js";
import { closeSandboxes } from "./sandbox.js";

// Platform tests keep no standby between their separate Docker fixtures.
beforeAll(closeSandboxes);

// A failed Docker step is the platform's, so the run gets its retries; a failed install is the
// automation's own and fails the run at once (f-170).
describe("platform runs whose run image cannot be assembled", () => {
  it.each(
    [
      "failed to export layer: NotFound: lease does not exist: not found",
      "failed to export layer: failed to commit: rename /var/lib/containerd/io.containerd.content.v1.content/ingest/7387bd65/data /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/cb2369ba: no such file or directory",
    ].flatMap((commitError) =>
      (["once", "always"] as const).map((failCommit) => ({ commitError, failCommit })),
    ),
  )(
    "records reassembly after a concurrent image prune interrupts the commit $failCommit: $commitError",
    async ({ failCommit, commitError }) => {
      const docker = await fakeDocker({
        missingImage: true,
        failCommit,
        commitError,
      });
      const platform = await testPlatform();
      const automationDirectory = await createAutomationFixture({
        name: "pruned-assembly",
        triggerLines: ["  type: webhook", "  path: /pruned-assembly"],
        configLines: ["runtime:", "  execution_mode: container"],
      });
      await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });
      const run = await platform.enqueuePlatformRun({
        automationName: "pruned-assembly",
        environment: "local",
      });

      await platform.processNextPlatformRun();
      const recorded = await platform.getPlatformRun(run.runId);

      expect(recorded.stderr).toContain(
        "Run image assembly lost its containerd lease, likely to a concurrent docker image prune. Reassembling once.",
      );
      expect(recorded.executions).toHaveLength(1);
      if (failCommit === "once") {
        expect(recorded).toMatchObject({ status: "succeeded", result: { ok: true } });
      } else {
        expect(recorded).toMatchObject({
          status: "dead-lettered",
          executions: [
            {
              errorClassification: "terminal",
              errorCode: "CONTAINER_IMAGE_PRUNE_INTERRUPTED",
              errorMessage: expect.stringContaining("likely to a concurrent docker image prune"),
            },
          ],
        });
      }
      const calls = await docker.calls();
      expect(calls.filter((call) => call.startsWith("commit"))).toHaveLength(2);
      expect(calls.filter((call) => call.startsWith("rm --force swizzle-image-"))).toHaveLength(2);
    },
  );

  it("reports preparation while the image install is blocked", async ({ signal }) => {
    const docker = await fakeDocker({ missingImage: true, installGate: true });
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-preparing-"), "artifacts"),
    });
    const directory = await createAutomationFixture({
      name: "preparing-image",
      triggerLines: ["  type: webhook", "  path: /preparing-image"],
      configLines: [
        "runtime:",
        "  execution_mode: container",
        "  requirements:",
        "    node:",
        "      package_json: package.json",
      ],
    });
    await writeFile(path.join(directory, "package.json"), '{"name":"preparing-image"}');
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: directory,
    });
    const run = await platform.enqueuePlatformRun({
      environment: "local",
      automationName: "preparing-image",
    });
    const executing = platform.processNextPlatformRun();
    try {
      await waitFor(signal, async () =>
        (await docker.calls()).some((call) => call.startsWith("start --attach")),
      );
      expect((await platform.getPlatformRun(run.runId)).executions.at(-1)?.phase).toBe("preparing");
    } finally {
      await docker.releaseInstall();
      await executing;
      await closeSandboxes();
    }
    expect(await platform.getPlatformRun(run.runId)).toMatchObject({ status: "succeeded" });
    expect((await platform.getPlatformRun(run.runId)).executions.at(-1)?.phase).toBe("executing");
  });

  it("retries a run after a Docker failure and dead-letters one whose install failed", async () => {
    await fakeDocker({ failCommit: "always", failInstall: true, missingImage: true });
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-platform-"), "artifacts"),
    });
    const container = ["runtime:", "  execution_mode: container"];
    const daemonFailure = await createAutomationFixture({
      configLines: container,
      name: "daemon-failure",
      triggerLines: ["  type: webhook", "  path: /daemon-failure"],
    });
    const brokenInstall = await createAutomationFixture({
      configLines: [
        ...container,
        "  requirements:",
        "    node:",
        "      package_json: package.json",
      ],
      name: "broken-install",
      triggerLines: ["  type: webhook", "  path: /broken-install"],
    });
    await writeFile(path.join(brokenInstall, "package.json"), '{"name":"broken-install"}\n');
    for (const [automationDirectory, deploymentId] of [
      [daemonFailure, "00000000-0000-4000-8000-000000000031"],
      [brokenInstall, "00000000-0000-4000-8000-000000000032"],
    ] as const) {
      await platform.deployAutomationToPlatform({
        automationDirectory,
        deploymentId,
        environment: "local",
      });
    }

    const runToItsEnd = async (automationName: string) => {
      const runId = randomUUID();
      await platform.enqueuePlatformRun({ automationName, environment: "local", runId });
      while ((await platform.processNextPlatformRun())?.status === "queued");
      return await platform.getPlatformRun(runId);
    };

    expect(await runToItsEnd("daemon-failure")).toMatchObject({
      executions: [
        { errorClassification: "retryable", errorCode: "CONTAINER_RUNTIME_UNAVAILABLE" },
        { errorClassification: "retryable", errorCode: "CONTAINER_RUNTIME_UNAVAILABLE" },
        { errorClassification: "retryable", errorCode: "CONTAINER_RUNTIME_UNAVAILABLE" },
      ],
      status: "dead-lettered",
    });
    expect(await runToItsEnd("broken-install")).toMatchObject({
      executions: [{ errorClassification: "terminal", errorCode: "CONTAINER_BUILD_FAILED" }],
      status: "dead-lettered",
    });
  });

  // Another attempt meets the same setting, so retrying it would only spend the budget (f-286).
  it("fails a run once when the worker's run limit setting is invalid", async () => {
    await fakeDocker({ missingImage: false });
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-platform-"), "artifacts"),
    });
    const automationDirectory = await createAutomationFixture({
      configLines: ["runtime:", "  execution_mode: container"],
      name: "misconfigured-worker",
      triggerLines: ["  type: webhook", "  path: /misconfigured-worker"],
    });
    await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });
    // The worker reads the setting before each run, so one set after the deploy reaches it.
    vi.stubEnv("SWIZZLE_MAX_RUN_MEMORY_MB", "2GB");

    await platform.enqueuePlatformRun({
      automationName: "misconfigured-worker",
      environment: "local",
      runId: "9f6921c0-9cc2-57bf-a1d1-baef9910b23f",
    });
    while ((await platform.processNextPlatformRun())?.status === "queued");

    expect(await platform.getPlatformRun("9f6921c0-9cc2-57bf-a1d1-baef9910b23f")).toMatchObject({
      executions: [
        {
          errorClassification: "terminal",
          errorCode: "PLATFORM_CONFIG_INVALID",
          errorMessage: 'SWIZZLE_MAX_RUN_MEMORY_MB must be a positive number, not "2GB".',
        },
      ],
      status: "dead-lettered",
    });
  });
});

// A run and its API check exec the same run image; only the script and the inputs differ. Runs
// after closeSandboxes, so the platform run leaves no standby behind.
describe("deployed runs and checks in the sandbox", () => {
  it("gives a run its state and steps, and its check neither", async () => {
    const docker = await fakeDocker({ missingImage: false });
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-platform-"), "artifacts"),
    });
    const directory = await createAutomationFixture({
      configLines: [
        "runtime:",
        "  execution_mode: container",
        "api_check:",
        "  mode: active",
        "  entrypoint: check.js",
      ],
      name: "sandboxed-check",
      triggerLines: ["  type: webhook", "  path: /sandboxed-check"],
    });
    await writeFile(path.join(directory, "check.js"), "console.log('{\"ok\":true}')\n");
    await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
    const execOf = async () => {
      const exec = (await docker.calls()).findLast((call) => call.startsWith("exec "));
      return { command: exec?.split(" swizzle-run ")[1], exec, inputs: await docker.inputs() };
    };

    await platform.enqueuePlatformRun({
      automationName: "sandboxed-check",
      environment: "local",
      runId: "0b0f748e-1fb4-52ed-9a2d-365a29136ace",
    });
    expect((await platform.processNextPlatformRun())?.status).toBe("succeeded");
    const run = await execOf();
    const [check] = await platform.store.listDueAutomationChecks(new Date().toISOString(), "local");
    const recorded = await platform.processPlatformCheck(
      check?.checkId ?? "",
      check?.nextCheckAt ?? "",
      { environment: { PATH: process.env.PATH } },
    );
    const checked = await execOf();

    expect(run.command).toBe("node /automation/main.js");
    expect(run.inputs).toEqual(["./payload.json", "./state.json", "./steps.json"]);
    expect(run.exec).toContain("--env SWIZZLE_STATE_FILE=/run/swizzle/state.json");
    expect(run.exec).toContain("--env SWIZZLE_TRIGGER_TYPE=webhook");
    expect(recorded?.status).toBe("green");
    expect(checked.command).toBe("node /automation/check.js");
    expect(checked.inputs).toEqual(["./payload.json"]);
    expect(checked.exec).not.toContain("SWIZZLE_STATE_FILE");
    expect(checked.exec).not.toContain("SWIZZLE_STEPS_FILE");
    expect(checked.exec).toContain("--env SWIZZLE_TRIGGER_TYPE=check");
  });
});
