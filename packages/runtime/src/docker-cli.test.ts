import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { temporaryDirectory, waitFor } from "../../../test/support.js";
import {
  closeDockerScopes,
  DockerScope,
  leftoverContainers,
  removeAbandonedContainers,
  removeLeftoverContainers,
  sandboxProcessLabel,
} from "./docker-cli.js";
import { pruneRunImages } from "./run-image.js";

// f-431: a killed worker's sandboxes outlive it until their hold process ends, up to an hour.
it("removes what a restarted or gone worker left, and keeps a live replica's", () => {
  const containers = [
    { id: "own", owner: "worker-a" },
    { id: "replica", owner: "worker-b" },
    { id: "recreated", owner: "worker-gone" },
    { id: "unlabelled", owner: "" },
  ];

  expect(leftoverContainers(containers, new Set(["worker-a", "worker-b"]), "worker-a")).toEqual([
    "own",
    "recreated",
    "unlabelled",
  ]);
  // A worker process outside the Compose stack cannot tell which of them still run.
  expect(leftoverContainers(containers, new Set(["worker-b"]), "worker-a")).toEqual([]);
});

it("keeps the sandbox of a replica that starts while it lists the stack's containers", async () => {
  const directory = await temporaryDirectory("swizzle-docker-leftovers-");
  const started = path.join(directory, "replica-started");
  const removed = path.join(directory, "removed");
  // The replica starts, and makes its sandbox, while Docker answers the container listing.
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "rm") fs.appendFileSync(${JSON.stringify(removed)}, args.at(-1) + "\\n");
else if (args.includes("--all")) setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(started)}, "");
  console.log("sandbox-new worker-new\\nsandbox-gone worker-gone");
}, 300);
else console.log([require("node:os").hostname(), ...(fs.existsSync(${JSON.stringify(started)}) ? ["worker-new"] : [])].join("\\n"));
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  vi.stubEnv("SWIZZLE_STACK", "leftovers");

  expect(await removeLeftoverContainers()).toBe(1);
  expect(await readFile(removed, "utf8")).toBe("sandbox-gone\n");
});

it("bounds a Docker wrapper whose descendant inherits its output pipes", async ({ signal }) => {
  const directory = await temporaryDirectory("swizzle-docker-descendant-");
  const pidFile = path.join(directory, "descendant.pid");
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", process.stdout, process.stderr],
});
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  const deadline = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 5_000 ? deadline.signal : timeout(ms),
  );
  const owner = new DockerScope({ timeoutMs: 10_000, containerName: null });
  const outcome = owner
    .run(["image", "inspect", "probe"], { outputLimitBytes: 4096 })
    .catch((error: unknown) => error);
  let descendantPid = 0;
  try {
    await waitFor(signal, async () => {
      descendantPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      return descendantPid > 0;
    });
    deadline.abort(new DOMException("Docker control deadline exceeded", "TimeoutError"));
    // The descendant left the killed group and still holds the pipes, so a run that waited for
    // them would end only at the test's timeout.
    expect(await outcome).toMatchObject({ code: "DOCKER_CONTROL_TIMEOUT" });
    expect(() => process.kill(descendantPid, 0)).not.toThrow();
  } finally {
    await owner.close();
    // The wrapper wrote the pid file at once, also when the test ended before it read it.
    const pid = descendantPid || Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already terminated. */
      }
    }
  }
});

it.for([
  { name: "swizzle-run-late", expected: "removed" },
  { name: "swizzle-image-shared", expected: "created" },
])(
  "reconciles abandoned unique sandbox names, leaving reusable assembly names ($name)",
  async ({ name, expected }, { signal }) => {
    const directory = await temporaryDirectory("swizzle-late-create-");
    const started = path.join(directory, "started");
    const container = path.join(directory, "container");
    await writeFile(
      path.join(directory, "docker"),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'create') { fs.writeFileSync(${JSON.stringify(started)}, ''); setInterval(() => {}, 1000); }
else if (args[0] === 'ps' && fs.existsSync(${JSON.stringify(container)})) console.log(${JSON.stringify(name + " created ")} + ${JSON.stringify(sandboxProcessLabel().split("=")[1])});
else if (args[0] === 'rm') {
  if (fs.existsSync(${JSON.stringify(container)})) { fs.unlinkSync(${JSON.stringify(container)}); console.log(args.at(-1)); }
  // docker rm --force exits zero without output when the name does not exist.
}
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 5_000 ? deadline.signal : timeout(ms),
    );
    const scope = new DockerScope({ timeoutMs: 30_000, containerName: name });
    const created = scope.run(["create"], { outputLimitBytes: 4096 });
    await waitFor(signal, async () =>
      access(started).then(
        () => true,
        () => false,
      ),
    );
    deadline.abort(new DOMException("Docker deadline", "TimeoutError"));
    await expect(created).rejects.toMatchObject({ code: "DOCKER_CONTROL_TIMEOUT" });
    vi.restoreAllMocks();
    await scope.close();
    // A unique sandbox finishes late; a shared assembly name may already belong to a new owner.
    await writeFile(container, "created");
    await pruneRunImages({ keep: new Set() });
    expect(
      await access(container).then(
        () => "created",
        () => "removed",
      ),
    ).toBe(expected);
  },
);

it("does not keep issuing removals for a create that never produces a container", async ({
  signal,
}) => {
  const directory = await temporaryDirectory("swizzle-create-absent-");
  const started = path.join(directory, "started");
  const removals = path.join(directory, "removals");
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'create') { fs.writeFileSync(${JSON.stringify(started)}, ''); setInterval(() => {}, 1000); }
else if (args[0] === 'rm') fs.appendFileSync(${JSON.stringify(removals)}, args.at(-1) + '\\n');
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  const deadline = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 5_000 ? deadline.signal : timeout(ms),
  );
  const owner = new DockerScope({ timeoutMs: 30_000, containerName: "swizzle-run-never-created" });
  const created = owner.run(["create"], { outputLimitBytes: 4096 });
  await waitFor(signal, () =>
    access(started).then(
      () => true,
      () => false,
    ),
  );
  deadline.abort(new DOMException("Docker deadline", "TimeoutError"));
  await expect(created).rejects.toMatchObject({ code: "DOCKER_CONTROL_TIMEOUT" });
  vi.restoreAllMocks();
  await owner.close();
  for (let pass = 0; pass < 3; pass++) await removeAbandonedContainers();
  expect((await readFile(removals, "utf8")).trim().split("\n")).toEqual([
    "swizzle-run-never-created",
  ]);
});

it("removes only Created sandboxes of this process whose Docker owner has closed", async () => {
  const directory = await temporaryDirectory("swizzle-created-owners-");
  const removals = path.join(directory, "removed");
  const processId = sandboxProcessLabel().split("=")[1];
  const containers = [
    `swizzle-run-active created ${processId}`,
    `swizzle-run-other-process created other`,
    `swizzle-run-running running ${processId}`,
    `swizzle-image-shared created ${processId}`,
    `swizzle-run-abandoned-a created ${processId}`,
    `swizzle-run-abandoned-b created ${processId}`,
  ].join("\n");
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'ps') console.log(${JSON.stringify(containers)});
else if (process.argv[2] === 'rm') fs.appendFileSync(${JSON.stringify(removals)}, process.argv.at(-1) + '\\n');
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  const owner = new DockerScope({ timeoutMs: 30_000, containerName: "swizzle-run-active" });
  try {
    await removeAbandonedContainers();
    expect((await readFile(removals, "utf8")).trim().split("\n")).toEqual([
      "swizzle-run-abandoned-a",
      "swizzle-run-abandoned-b",
    ]);
  } finally {
    await owner.close();
  }
});

it("reaps unresponsive Docker commands and bounds independently owned cleanup", async ({
  signal,
}) => {
  const directory = await temporaryDirectory("swizzle-docker-deadline-");
  const log = path.join(directory, "calls.jsonl");
  await writeFile(
    path.join(directory, "docker"),
    // A shell script: a Node fake takes long enough to start on a loaded host that the five calls
    // outlast the test's timeout (f-276).
    `#!/bin/sh
printf '{"command":"%s","pid":%s}\\n' "$1" "$$" >> '${log}'
trap '' TERM
if [ "$1" = commit ]; then sleep 0.3; echo sha256:committed; exit 0; fi
exec sleep 1000
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  // Each control deadline is expired by the test once its fake docker process has logged its call.
  // A timer would also run while a loaded host is still starting that process, so the call would
  // be killed unlogged.
  const controlDeadlines: AbortController[] = [];
  let expireAll = false;
  const expire = (deadline: AbortController) =>
    deadline.abort(new DOMException("Docker control deadline exceeded", "TimeoutError"));
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    if (ms !== 5_000) return timeout(ms);
    const deadline = new AbortController();
    controlDeadlines.push(deadline);
    if (expireAll) expire(deadline);
    return deadline.signal;
  });
  const loggedCalls = async (): Promise<{ command: string; pid: number }[]> => {
    try {
      return (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const expireAfterLogged = async (callCount: number, deadlineIndex: number) => {
    await waitFor(signal, async () => (await loggedCalls()).length >= callCount);
    const deadline = controlDeadlines[deadlineIndex];
    if (deadline) expire(deadline);
  };

  const transfer = new DockerScope({ timeoutMs: 10_000, containerName: null });
  try {
    expect(await transfer.run(["commit"], { outputLimitBytes: 4096 })).toMatchObject({
      stdout: "sha256:committed\n",
    });
  } finally {
    await transfer.close();
  }
  try {
    const owner = new DockerScope({ timeoutMs: 10_000, containerName: "swizzle-run-stalled" });

    const created = owner.run(["create"], { outputLimitBytes: 4096 });
    await expireAfterLogged(2, 0);
    await expect(created).rejects.toMatchObject({ code: "DOCKER_CONTROL_TIMEOUT" });
    // close() retries removal under fresh deadlines, even though the create command already expired.
    const closing = owner.close();
    for (const attempt of [1, 2, 3]) {
      await expireAfterLogged(2 + attempt, attempt);
    }
    await closing;
  } finally {
    // A failed wait must not leave a fake docker process under a deadline nobody will expire.
    expireAll = true;
    for (const deadline of controlDeadlines) expire(deadline);
    await closeDockerScopes();
  }
  const calls = await loggedCalls();
  expect(calls.map((call) => call.command)).toEqual(["commit", "create", "rm", "rm", "rm"]);
  for (const { pid } of calls) expect(() => process.kill(pid, 0)).toThrow("ESRCH");
  expect(() => new DockerScope({ timeoutMs: 10_000, containerName: null })).toThrow(
    "Docker is shutting down.",
  );
});
