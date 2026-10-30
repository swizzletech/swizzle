import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { heldDeadlines, temporaryDirectory, waitFor } from "../../../test/support.js";
import {
  fakeDocker,
  makeDefinition,
  makeRunOptions,
  NODE_CONFIG,
  PYTHON_CONFIG,
} from "../test/container-docker.js";
import { prepareContainerAutomation, runContainerAutomation } from "./container-runner.js";
import { withLocalDockerStack } from "./docker-cli.js";
import { ensureRunImage, runImageRecipe, runImageTag } from "./run-image.js";

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, hostname: vi.fn(os.hostname) };
});

describe("run image recipes", () => {
  it("installs locked node dependencies without lifecycle scripts or ignored failures", () => {
    vi.stubEnv("SWIZZLE_RUNNER_BASE_IMAGE", "swizzle-runner-base:test");
    const recipe = runImageRecipe(
      makeDefinition(`
name: secure-run
version: 1.0.0
entrypoint: main.ts
trigger:
  type: webhook
runtime:
  execution_mode: container
  requirements:
    node:
      package_json: package.json
      lockfile: package-lock.json
`),
    );

    expect(recipe.baseImage).toBe("swizzle-runner-base:test");
    expect(recipe.install).toBe("npm ci --omit=dev --ignore-scripts --no-audit --no-fund");
    expect(recipe.command).toEqual([
      "/usr/local/bin/swizzle-entrypoint",
      "node",
      "/automation/main.ts",
    ]);
  });

  it("installs nothing for a python automation without requirements", () => {
    const recipe = runImageRecipe(makeDefinition(PYTHON_CONFIG));

    expect(recipe.install).toBeNull();
    expect(recipe.environment).toEqual([]);
    expect(recipe.command).toEqual(["python3", "/automation/main.py"]);
  });

  // f-430: a recreated worker container has a new hostname and must reuse the image.
  it("gives every worker host of the stack the same tag for the same source", async () => {
    const directory = await temporaryDirectory("swizzle-tag-source-");
    await writeFile(path.join(directory, "main.py"), "print('{}')\n");
    const recipe = runImageRecipe(makeDefinition(PYTHON_CONFIG, directory));
    vi.mocked(hostname).mockReturnValueOnce("worker-a").mockReturnValueOnce("worker-b");

    const [first, other] = [
      await runImageTag(directory, recipe),
      await runImageTag(directory, recipe),
    ];
    vi.stubEnv("SWIZZLE_STACK", "stack-b");

    expect(other).toBe(first);
    expect(await runImageTag(directory, recipe)).not.toBe(first);
  });

  it("rejects newline injection through a custom base image", () => {
    const definition = makeDefinition(
      `${NODE_CONFIG}  container:\n    base_image: "node:22-slim\\nRUN touch /owned"\n`,
    );

    expect(() => runImageRecipe(definition)).toThrow(
      "runtime.container.base_image must be a single valid container image reference",
    );
  });
});
describe("run image assembly", () => {
  it("replays assembly logs to joining runs and sends later logs to every waiter", async ({
    signal,
  }) => {
    const docker = await fakeDocker({
      missingImage: true,
      installGate: true,
      installOutput: "install output",
      failCommit: "once",
      commitError: "lease does not exist",
    });
    const options = await makeRunOptions(false);
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );
    const recipe = runImageRecipe(definition);
    const input = {
      automationDirectory: options.automationDirectory,
      recipe,
      tag: await runImageTag(options.automationDirectory, recipe),
    };
    const backgroundLogs: string[] = [];
    const firstLogs: string[] = [];
    const secondLogs: string[] = [];
    const background = ensureRunImage({
      ...input,
      onLog: (chunk) => {
        backgroundLogs.push(chunk);
      },
    });
    await waitFor(signal, () => backgroundLogs.join("") === "install output\n");
    const first = ensureRunImage({
      ...input,
      onLog: (chunk) => {
        firstLogs.push(chunk);
      },
    });
    const second = ensureRunImage({
      ...input,
      onLog: (chunk) => {
        secondLogs.push(chunk);
      },
    });
    try {
      await waitFor(
        signal,
        () =>
          firstLogs.join("") === "install output\n" && secondLogs.join("") === "install output\n",
      );
    } finally {
      await docker.releaseInstall();
      await Promise.allSettled([background, first, second]);
    }
    expect(await Promise.all([background, first, second])).toEqual([
      "assembled",
      "assembled",
      "assembled",
    ]);
    const expected =
      "install output\nRun image assembly lost its containerd lease, likely to a concurrent docker image prune. Reassembling once.\ninstall output\n";
    expect(backgroundLogs.join("")).toBe(expected);
    expect(firstLogs.join("")).toBe(expected);
    expect(secondLogs.join("")).toBe(expected);
  });

  it("fails every waiter when shared assembly logs exceed their own byte bound", async () => {
    await fakeDocker({ missingImage: true, installOutput: "x".repeat(1_048_577) });
    const options = await makeRunOptions(false);
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );
    const recipe = runImageRecipe(definition);
    const input = {
      automationDirectory: options.automationDirectory,
      recipe,
      tag: await runImageTag(options.automationDirectory, recipe),
    };
    const outcomes = await Promise.allSettled([ensureRunImage(input), ensureRunImage(input)]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: {
          code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
          message: "Image assembly logs exceeded 1048576 bytes.",
        },
      });
    }
  });

  it("fails only the run whose log limit is exceeded during shared image assembly", async ({
    signal,
  }) => {
    const docker = await fakeDocker({
      missingImage: true,
      installGate: true,
      installOutput: "install output",
      failCommit: "once",
      commitError: "lease does not exist",
    });
    const options = await makeRunOptions(false);
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );
    let healthyLogs = "";
    let limitedLogs = "";
    const healthy = runContainerAutomation({
      ...options,
      definition,
      onStderrChunk: (chunk) => {
        healthyLogs += chunk;
      },
    });
    await waitFor(signal, () => healthyLogs === "install output\n");
    const limited = runContainerAutomation({
      ...options,
      definition,
      runId: "03d4f57b-25b6-5fc7-9bea-96f6190920d8",
      outputLimitBytes: 24,
      onStderrChunk: (chunk) => {
        limitedLogs += chunk;
      },
    });
    try {
      await waitFor(signal, () => limitedLogs === "install output\n");
    } finally {
      await docker.releaseInstall();
      await Promise.allSettled([healthy, limited]);
    }
    expect(await limited).toMatchObject({ success: false, code: "PROCESS_OUTPUT_LIMIT_EXCEEDED" });
    expect(await healthy).toMatchObject({ success: true, result: { ok: true } });
    expect((await docker.calls()).filter((call) => call.startsWith("commit"))).toHaveLength(2);
  });

  it("assembles a missing image, labels it with the stack and runs once in a new sandbox", async ({
    signal,
  }) => {
    const docker = await fakeDocker({ missingImage: true });
    vi.stubEnv("SWIZZLE_STACK", "stack-a");

    const result = await runContainerAutomation(await makeRunOptions(false));
    // The sandbox's removal runs after the result, in the background.
    await docker.reached(signal, "rm --force swizzle-run-");
    const calls = await docker.calls();

    expect(result.success).toBe(true);
    expect(result.phases?.standby).toBe(false);
    expect(result.phases?.image).toBeTypeOf("number");
    // The assembly container's removal runs in the background, so its place in the log varies.
    const assembly = /--name (swizzle-image-\S+)/u.exec(calls[1] ?? "")?.[1];
    expect(calls).toContain(`rm --force ${assembly}`);
    expect(
      calls
        .filter((call) => call !== `rm --force ${assembly}`)
        .slice(0, 9)
        .map((call) => call.split(" ")[0]),
    ).toEqual(["image", "create", "image", "cp", "commit", "tag", "create", "start", "exec"]);
    expect(calls.find((call) => call.startsWith("tag "))).toMatch(
      /^tag .*swizzle-run:[0-9a-f]{24}$/u,
    );
    // The Docker broker acts only on containers with the stack label, sandboxes included.
    expect(calls[1]).toContain("--label swizzle.stack=local-stack-a");
    expect(calls.find((call) => call.startsWith("create --name swizzle-run-"))).toContain(
      "--label swizzle.stack=local-stack-a",
    );
    // A local run that assembled an image prunes only its local stack's run images.
    expect(calls).toContain(
      "image ls --all --filter label=swizzle.stack=local-stack-a --quiet --no-trunc",
    );
  });

  it.for(["image inspect", "create", "start"])(
    "bounds a stalled %s before execution",
    async (stallControl, { signal }) => {
      const docker = await fakeDocker({ missingImage: false, stallControl });
      const deadlines = heldDeadlines(stallControl === "create" ? 60_000 : 5_000);

      const run = runContainerAutomation(await makeRunOptions(false));
      await docker.reached(signal, stallControl);
      deadlines.expireNewest();

      expect(await run).toMatchObject({
        success: false,
        message: expect.stringContaining(
          stallControl === "create" ? "DOCKER_TRANSFER_TIMEOUT" : "DOCKER_CONTROL_TIMEOUT",
        ),
      });
    },
  );

  it("waits for the image another worker on the engine assembles instead of assembling it too", async () => {
    const docker = await fakeDocker({ assembledElsewhere: true, missingImage: true });

    const result = await runContainerAutomation(await makeRunOptions(false));
    const calls = await docker.calls();

    expect(result.success).toBe(true);
    expect(calls.filter((call) => call.startsWith("create --name swizzle-image-"))).toHaveLength(1);
    expect(calls.some((call) => /^(cp|commit|tag) /u.test(call))).toBe(false);
    expect(calls.some((call) => call.startsWith("rm --force swizzle-image-"))).toBe(false);
  });

  it("assembles once more after a failed Docker step and removes both assembly containers", async () => {
    const docker = await fakeDocker({ failCommit: "always", missingImage: true });

    const result = await runContainerAutomation(await makeRunOptions(false));
    const calls = await docker.calls();
    const assemblies = calls.flatMap((call) => /--name (swizzle-image-\S+)/u.exec(call)?.[1] ?? []);

    expect(result.success ? null : result.code).toBe("CONTAINER_RUNTIME_UNAVAILABLE");
    expect(assemblies).toHaveLength(2);
    for (const assembly of assemblies) expect(calls).toContain(`rm --force ${assembly}`);
    expect(calls.some((call) => call.startsWith("exec"))).toBe(false);
  });

  it("runs after a Docker step failed once", async () => {
    const docker = await fakeDocker({ failCommit: "once", missingImage: true });

    const result = await runContainerAutomation(await makeRunOptions(false));
    const calls = await docker.calls();

    expect(result.success).toBe(true);
    expect(calls.filter((call) => call.startsWith("commit"))).toHaveLength(2);
  });

  it.each([16, 128])("bounds assembly and process stderr together at %s bytes", async (limit) => {
    const docker = await fakeDocker({
      failCommit: "once",
      commitError: "lease does not exist",
      missingImage: true,
      execStderr: "x".repeat(100),
      execStdout: '{"value":"independent stdout"}',
      execAfterOutputStalls: true,
    });
    const streamed: string[] = [];
    const options = await makeRunOptions(false);

    const result = await runContainerAutomation({
      ...options,
      outputLimitBytes: limit,
      onStderrChunk: (chunk) => {
        streamed.push(chunk);
      },
      onStdoutChunk: () => docker.releaseStderr(),
    });

    await withLocalDockerStack(() => prepareContainerAutomation({ ...options, standby: false }));

    expect(result).toMatchObject({
      success: false,
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      message:
        limit === 16
          ? "Image assembly stderr exceeded 16 bytes."
          : "Automation stderr exceeded 128 bytes.",
    });
    expect(Buffer.byteLength(result.stderr)).toBe(limit);
    expect(streamed.join("")).toBe(result.stderr);
    if (limit === 128) {
      expect(result.stdout).toBe('{"value":"independent stdout"}\n');
      expect(result.stderr).toBe(
        "Run image assembly lost its containerd lease, likely to a concurrent docker image prune. Reassembling once.\n" +
          "x".repeat(20),
      );
      expect((await docker.calls()).join("\n")).toContain("stop --time 1 swizzle-run-");
    }
  });

  it("returns bounded install output when its data callback exceeds the run limit", async () => {
    await fakeDocker({ missingImage: true, installOutput: "i".repeat(100) });
    const options = await makeRunOptions(false);
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );
    const chunks: string[] = [];

    const result = await runContainerAutomation({
      ...options,
      definition,
      outputLimitBytes: 16,
      onStderrChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    await withLocalDockerStack(() =>
      prepareContainerAutomation({ ...options, definition, standby: false }),
    );

    expect(result).toMatchObject({
      success: false,
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      stderr: "i".repeat(16),
    });
    expect(chunks.join("")).toBe("i".repeat(16));
  });

  // An install that exits non-zero is the automation's own failure; Docker failing while it runs
  // the install step is the platform's, which the run retries.
  it.for([
    {
      attaches: 1,
      code: "CONTAINER_BUILD_FAILED",
      failure: "the install step fails",
      fake: { failInstall: true },
    },
    {
      attaches: 2,
      code: "CONTAINER_RUNTIME_UNAVAILABLE",
      failure: "Docker fails during the install step",
      fake: { failAttach: true },
    },
    {
      attaches: 0,
      code: "CONTAINER_RUNTIME_UNAVAILABLE",
      failure: "the Docker CLI cannot start for the install step",
      fake: { cliGoneAtAttach: true },
    },
  ])("reports $code when $failure", async ({ attaches, code, fake }) => {
    const docker = await fakeDocker({ ...fake, missingImage: true });
    const options = await makeRunOptions(false);
    await writeFile(path.join(options.automationDirectory, "requirements.txt"), "missing==1\n");
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );

    const result = await runContainerAutomation({ ...options, definition });
    const calls = await docker.calls();

    expect(result).toMatchObject({ code, success: false });
    expect(calls.filter((call) => call.startsWith("start --attach"))).toHaveLength(attaches);
  });

  // The install step runs dependency code, such as a PEP 517 backend, so it gets the run's bounds.
  it("runs the install step under the run sandbox's resource limits", async () => {
    const docker = await fakeDocker({ missingImage: true });
    const options = await makeRunOptions(false);
    await writeFile(path.join(options.automationDirectory, "requirements.txt"), "./backend\n");
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  container:\n    memory_mb: 768\n    cpus: "1.5"\n  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );

    const result = await runContainerAutomation({ ...options, definition });
    const creates = (await docker.calls()).filter((call) => call.startsWith("create"));

    expect(result.success).toBe(true);
    // The install container, then the run sandbox.
    expect(creates).toHaveLength(2);
    for (const create of creates) {
      expect(create).toContain(
        "--pids-limit 128 --ulimit nofile=1024:1024 --memory 768m --memory-swap 768m --cpus 1.5",
      );
      // RLIMIT_NPROC counts the sandbox user's tasks in every container on the host (f-222), so
      // one run would starve the others. The PID limit bounds each container on its own.
      expect(create).not.toContain("nproc");
    }
  });

  it("stops an install whose writable layer grows past the install disk limit", async () => {
    vi.stubEnv("SWIZZLE_MAX_INSTALL_DISK_MB", "64");
    const docker = await fakeDocker({ layerMiB: 100, missingImage: true });
    const options = await makeRunOptions(false);
    await writeFile(path.join(options.automationDirectory, "requirements.txt"), "./backend\n");
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );

    const result = await runContainerAutomation({ ...options, definition });
    const calls = await docker.calls();
    const assembly = calls.flatMap(
      (call) => /--name (swizzle-image-\S+)/u.exec(call)?.[1] ?? [],
    )[0];

    expect(result.success ? null : result.message).toContain(
      "The install container's writable layer reached 100 MiB, more than the install disk limit of 64 MiB set by SWIZZLE_MAX_INSTALL_DISK_MB.",
    );
    expect(calls).toContain(`kill ${assembly}`);
    expect(calls.some((call) => call.startsWith("commit"))).toBe(false);
    expect(calls.filter((call) => call.startsWith("start --attach"))).toHaveLength(1);
  });

  it("commits no image when the install container's layer size cannot be read", async () => {
    const docker = await fakeDocker({ missingImage: true, sizeUnknown: true });
    const options = await makeRunOptions(false);
    await writeFile(path.join(options.automationDirectory, "requirements.txt"), "./backend\n");
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );

    const result = await runContainerAutomation({ ...options, definition });
    const calls = await docker.calls();

    expect(result.success ? null : result.message).toContain(
      "Could not read the install container's writable layer size",
    );
    expect(calls.some((call) => call.startsWith("commit"))).toBe(false);
  });

  it.for([false, true])(
    "preserves a size-inspection deadline (install running: %s)",
    async (installRunning, { signal }) => {
      const docker = await fakeDocker({
        missingImage: true,
        stallControl: "container inspect",
        installGate: installRunning,
      });
      const options = await makeRunOptions(false);
      await writeFile(path.join(options.automationDirectory, "requirements.txt"), "slow==1\n");
      const definition = makeDefinition(
        `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
        options.automationDirectory,
      );
      const deadlines = heldDeadlines(5_000);
      const run = runContainerAutomation({ ...options, definition });
      try {
        await docker.reached(signal, "container inspect");
        deadlines.expireNewest();
        expect(await run).toMatchObject({ success: false, code: "DOCKER_CONTROL_TIMEOUT" });
        const calls = await docker.calls();
        const assembly = calls.flatMap(
          (call) => /--name (swizzle-image-\S+)/u.exec(call)?.[1] ?? [],
        )[0];
        expect(calls).toContain(`rm --force ${assembly}`);
        expect(calls.filter((call) => call.startsWith("start --attach"))).toHaveLength(1);
        expect(calls.some((call) => call.startsWith("commit"))).toBe(false);
      } finally {
        await docker.releaseInstall();
        await run;
      }
    },
  );

  it("stops a stalled install step at the assembly deadline and removes its container", async ({
    signal,
  }) => {
    const docker = await fakeDocker({ failInstall: "stall", missingImage: true });
    const options = await makeRunOptions(false);
    await writeFile(path.join(options.automationDirectory, "requirements.txt"), "slow==1\n");
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );
    // The assembly deadline, ten minutes, the test expires once the install step runs.
    const deadlines = heldDeadlines(600_000);

    const run = runContainerAutomation({ ...options, definition });
    await docker.reached(signal, "start --attach");
    deadlines.expireNewest();
    const result = await run;
    const calls = await docker.calls();
    const assembly = calls.flatMap(
      (call) => /--name (swizzle-image-\S+)/u.exec(call)?.[1] ?? [],
    )[0];

    expect(result.success ? null : result.code).toBe("CONTAINER_BUILD_FAILED");
    expect(result.success ? null : result.message).toContain("docker start stopped");
    expect(calls).toContain(`rm --force ${assembly}`);
  });

  it("removes the committed image, not the tag, when tagging it fails", async () => {
    const docker = await fakeDocker({ failTag: true, missingImage: true });

    const result = await runContainerAutomation(await makeRunOptions(false));
    const calls = await docker.calls();

    expect(result.success ? null : result.code).toBe("CONTAINER_RUNTIME_UNAVAILABLE");
    // Both attempts commit, fail to tag, and remove what they committed.
    expect(calls.filter((call) => call.startsWith("image rm"))).toEqual([
      "image rm sha256:committed",
      "image rm sha256:committed",
    ]);
  });

  it("cancels one run without cancelling their shared image assembly", async ({ signal }) => {
    const docker = await fakeDocker({ missingImage: true, installGate: true });
    const options = await makeRunOptions(false);
    await writeFile(path.join(options.automationDirectory, "requirements.txt"), "slow==1\n");
    const definition = makeDefinition(
      `${PYTHON_CONFIG}  requirements:\n    python:\n      requirements_file: requirements.txt\n`,
      options.automationDirectory,
    );
    const cancellation = new AbortController();
    const first = runContainerAutomation({
      ...options,
      definition,
      abortSignal: cancellation.signal,
    });
    const second = runContainerAutomation({
      ...options,
      definition,
      runId: "03d4f57b-25b6-5fc7-9bea-96f6190920d8",
    });
    await waitFor(signal, async () => {
      const calls = await docker.calls();
      return (
        calls.filter((call) => call.startsWith("image inspect")).length >= 2 &&
        calls.some((call) => call.startsWith("start --attach"))
      );
    });
    expect((await docker.calls()).filter((call) => call.startsWith("start --attach"))).toHaveLength(
      1,
    );

    cancellation.abort();
    await docker.releaseInstall();
    expect(await first).toMatchObject({ success: false, code: "RUN_CANCELLED" });
    expect(await second).toMatchObject({ success: true, result: { ok: true } });
    expect((await docker.calls()).filter((call) => call.startsWith("commit"))).toHaveLength(1);
  });
});
