import { describe, expect, it, vi } from "vitest";
import { heldDeadlines, waitFor } from "../../../test/support.js";
import {
  fakeDocker,
  isRunning,
  makeDefinition,
  makeRunOptions,
  NODE_CONFIG,
} from "../test/container-docker.js";
import {
  prepareContainerAutomation,
  runContainerAutomation,
  sandboxExecArguments,
} from "./container-runner.js";
import { runImageRecipe, runImageTag } from "./run-image.js";
import {
  claimSandbox,
  closeSandboxes,
  prewarmSandbox,
  runEgressEnvironment,
  sandboxSpec,
} from "./sandbox.js";

describe("sandbox hardening", () => {
  it("creates a read-only, capability-free, bounded sandbox without network unless permitted", () => {
    const definition = makeDefinition(`${NODE_CONFIG}  permissions:\n    network: false\n`);
    const spec = sandboxSpec(definition, "swizzle-run:test");
    const wire = spec.createArguments.join(" ");

    expect(wire).toContain("--read-only");
    expect(wire).toContain("--cap-drop ALL");
    expect(wire).toContain("--security-opt no-new-privileges:true");
    expect(wire).toContain("--pids-limit 128");
    expect(wire).toContain("--user 65532:65532");
    expect(wire).toContain("--network none");
    expect(wire).toContain(
      "--tmpfs /run/swizzle:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65532,gid=65532",
    );
  });

  // A standby is created before its run, so nothing run-specific may be in its create arguments.
  it("passes secrets and run metadata with the exec, never with the sandbox's creation", () => {
    const spec = sandboxSpec(makeDefinition(NODE_CONFIG), "swizzle-run:test");
    const exec = sandboxExecArguments("swizzle-run-x", { AGENT_API_KEY: "secret" }, ["node", "m"]);

    expect(spec.createArguments.join(" ")).not.toContain("--env");
    expect(exec.join(" ")).toContain("--env AGENT_API_KEY=secret swizzle-run-x /bin/sh -c");
    expect(exec.slice(-3)).toEqual(["swizzle-run", "node", "m"]);
  });

  it("routes a permitted network through the egress proxy", () => {
    vi.stubEnv("SWIZZLE_RUNNER_NETWORK", "test-runner-network");
    vi.stubEnv("SWIZZLE_RUNNER_EGRESS_PROXY", "http://egress.test:3128");
    vi.stubEnv("SWIZZLE_RUNNER_BASE_IMAGE", "swizzle-runner-base:test");
    const definition = makeDefinition(`${NODE_CONFIG}  permissions:\n    network: true\n`);

    expect(sandboxSpec(definition, "swizzle-run:test").createArguments.join(" ")).toContain(
      "--network test-runner-network",
    );
    expect(runEgressEnvironment(definition)).toEqual({ SWIZZLE_EGRESS_PROXY: "egress.test:3128" });
  });

  it("gives custom runner bases the HTTP proxy variables and no managed entrypoint", () => {
    vi.stubEnv("SWIZZLE_RUNNER_EGRESS_PROXY", "http://egress.test:3128");
    vi.stubEnv("SWIZZLE_RUNNER_BASE_IMAGE", "swizzle-runner-base:test");
    const definition = makeDefinition(`${NODE_CONFIG}  container:\n    base_image: node:22-slim\n`);

    expect(runEgressEnvironment(definition).HTTP_PROXY).toBe("http://egress.test:3128");
    expect(runImageRecipe(definition).command).toEqual(["node", "/automation/main.js"]);
  });
});
describe("sandbox execution", () => {
  it("awaits asynchronous output and reports callback failures", async ({ signal }) => {
    const docker = await fakeDocker({ missingImage: false });
    const chunks: string[] = [];
    const options = await makeRunOptions(false);
    let releaseWrite = () => {};
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let returned = false;
    const running = runContainerAutomation({
      ...options,
      onStdoutChunk: async (chunk) => {
        await writeHeld;
        chunks.push(chunk);
      },
    }).finally(() => {
      returned = true;
    });
    // The exec has exited with its stdout write still pending, so only that write holds the
    // execution open.
    await waitFor(signal, async () => {
      const pid = await docker.execPid().catch(() => 0);
      return pid > 0 && !isRunning(pid);
    });
    expect(returned).toBe(false);
    releaseWrite();
    const result = await running;
    expect(result.success).toBe(true);
    expect(chunks.join("")).toContain("ok");
    // A rejected write fails the execution only when the runner awaits it.
    const failed = await runContainerAutomation({
      ...options,
      onStdoutChunk: async () => {
        throw new Error("output persistence failed");
      },
    });
    expect(failed).toMatchObject({ success: false, message: "output persistence failed" });
  });

  // The API reads steps, state and suspends from what the worker reports, and redacts link tokens
  // itself where it stores and shows output; a worker that redacted them would store dead links.
  it("reports approval and event link tokens as the automation printed them", async () => {
    const link = `https://links.example.com/events/${"0b1e7c2a-5f3d-4c6b-9a8e-1d2f3a4b5c6d"}.aG9vaw.${"s".repeat(43)}`;
    await fakeDocker({ execStdout: JSON.stringify({ link }), missingImage: false });
    const chunks: string[] = [];
    const result = await runContainerAutomation({
      ...(await makeRunOptions(false)),
      onStdoutChunk: (chunk) => {
        chunks.push(chunk);
      },
    });
    expect(result).toMatchObject({ result: { link }, success: true });
    expect(chunks.join("")).toContain(link);
  });

  it("preserves UTF-8 prefixes and byte order marks within the output budget", async () => {
    const docker = await fakeDocker({
      missingImage: false,
      execStdout: '\uFEFF{"ok":true}',
      execStderr: "\uFEFF😀😀😀😀",
    });
    const chunks: string[] = [];
    const result = await runContainerAutomation({
      ...(await makeRunOptions(false)),
      outputLimitBytes: 16,
      onStdoutChunk: () => docker.releaseStderr(),
      onStderrChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(result).toMatchObject({
      success: false,
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      stdout: '\uFEFF{"ok":true}\n',
      stderr: "\uFEFF😀😀😀",
    });
    expect(chunks.join("")).toBe("\uFEFF😀😀😀");
  });

  it("reports a stalled standby create without starting another create", async ({ signal }) => {
    const docker = await fakeDocker({ missingImage: false, stallControl: "create" });
    const options = await makeRunOptions(false);
    const spec = sandboxSpec(
      options.definition,
      await runImageTag(options.automationDirectory, runImageRecipe(options.definition)),
    );
    const deadlines = heldDeadlines(60_000);
    const preparation = prewarmSandbox(spec, options.timeoutMs).catch(() => undefined);
    // A run's claim takes the pending standby at once, so its create is still stalled when the
    // test expires its deadline.
    const claim = claimSandbox(spec, { lifetimeMs: options.timeoutMs, replace: false });
    await docker.reached(signal, "create");
    deadlines.expireNewest();

    await expect(claim).rejects.toMatchObject({ code: "DOCKER_TRANSFER_TIMEOUT" });
    await preparation;
    expect((await docker.calls()).filter((call) => call.startsWith("create"))).toHaveLength(1);
  });

  // The run's deadline asks Docker to stop the sandbox. When the daemon no longer answers the exec,
  // that stop does not end it, and the worker kills the exec CLI itself (f-247).
  it("ends a run whose docker exec stops answering after its deadline, and kills the exec", async ({
    signal,
  }) => {
    const docker = await fakeDocker({ execHangs: true, missingImage: false });

    const result = await runContainerAutomation({
      ...(await makeRunOptions(false)),
      timeoutMs: 100,
    });
    const exec = await docker.execPid();

    expect(result).toMatchObject({ success: false, code: "PROCESS_TIMEOUT" });
    expect((await docker.calls()).some((call) => call.startsWith("stop --time 1"))).toBe(true);
    await waitFor(signal, () => !isRunning(exec));
  });

  // Runs last in this file: closing makes the process keep no standby afterwards.
  it("prepares a standby before the first run, and each platform run replaces the one it used", async () => {
    const docker = await fakeDocker({ missingImage: false });
    const options = await makeRunOptions(true);

    await prepareContainerAutomation({ ...options, standby: true });
    const prepared = await docker.calls();
    const first = await runContainerAutomation(options);
    const second = await runContainerAutomation(options);
    await closeSandboxes();
    const calls = await docker.calls();

    expect(prepared.filter((call) => call.startsWith("start swizzle-run-"))).toHaveLength(1);
    expect([first.phases?.standby, second.phases?.standby]).toEqual([true, true]);
    expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(3);
    expect(calls.filter((call) => call.startsWith("rm --force swizzle-run-"))).toHaveLength(3);
  });
});
