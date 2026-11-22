import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { fixture, invoke, ownedProcess, processAlive } from "../test/dev-stack.js";
import { temporaryDirectory, waitFor } from "../test/support.js";

test("just dev-down leaves a running verifier's project alone", async ({ signal }) => {
  const f = await fixture();
  await writeFile(
    path.join(f.root, "bin/docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> docker-calls
case " $* " in *" port "*) echo 127.0.0.1:1 ;; esac
`,
  );
  const verifier = spawn(
    process.execPath,
    [
      "scripts/dev-stack.mts",
      "verify",
      "--",
      process.execPath,
      "-e",
      `const fs = require("node:fs");
const watch = fs.watch(".", () => {
  if (fs.existsSync("verifier-release")) watch.close();
});
fs.writeFileSync("verifier-ready", process.env.DATABASE_URL);`,
    ],
    { cwd: f.root, env: f.env, stdio: "ignore" },
  );
  const exited = once(verifier, "exit");
  const release = () => writeFile(path.join(f.root, "verifier-release"), "");
  onTestFinished(async () => {
    await release();
    await exited;
  });
  await waitFor(signal, () => existsSync(path.join(f.root, "verifier-ready")));
  expect(await readFile(path.join(f.root, "verifier-ready"), "utf8")).toMatch(
    /@127\.0\.0\.1:1\/swizzle$/u,
  );

  const result = await invoke("just", ["dev-down"], { cwd: f.root, env: f.env });

  expect(result.status, result.stderr).toBe(0);
  const calls = path.join(f.root, "docker-calls");
  const project = /compose -p (\S+) -f \S+ up/u.exec(await readFile(calls, "utf8"))?.[1];
  if (!project) throw new Error("Verifier did not start a Compose project");
  expect(await readFile(calls, "utf8")).not.toContain(
    `-p ${project} -f infra/docker/compose.dev.yml down`,
  );
  expect(processAlive(verifier.pid)).toBe(true);

  await release();
  expect((await exited)[0]).toBe(0);
  expect(await readFile(calls, "utf8")).toContain(
    `-p ${project} -f infra/docker/compose.dev.yml down --volumes`,
  );
});

test("down dev stops the persistent project and keeps its data without a stack record", async () => {
  const f = await fixture();
  const calls = path.join(f.root, "docker-calls");
  const devData = path.join(f.root, ".git/swizzle-dev");
  await mkdir(devData);
  await writeFile(
    path.join(f.root, "bin/docker"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> docker-calls\n',
  );

  const result = await invoke(process.execPath, ["scripts/dev-stack.mts", "down", "dev"], {
    cwd: f.root,
    env: f.env,
  });

  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(calls, "utf8")).toMatch(
    /^compose -p swizzle-dev-swizzle-owner-[\w-]+ -f infra\/docker\/compose\.dev\.yml stop\n$/u,
  );
  expect(existsSync(devData)).toBe(true);
});

test("just dev-down removes the verification project with its volumes", async () => {
  const f = await fixture();
  const calls = path.join(f.root, "docker-calls");
  const verifyData = path.join(f.root, ".git/swizzle-dev-verify");
  await mkdir(verifyData);
  await writeFile(
    path.join(f.root, "bin/docker"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> docker-calls\n',
  );

  const result = await invoke("just", ["dev-down"], { cwd: f.root, env: f.env });

  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(calls, "utf8")).toMatch(
    /^compose -p swizzle-dev-verify-swizzle-owner-[\w-]+ -f infra\/docker\/compose\.dev\.yml down --volumes --remove-orphans$/mu,
  );
  expect(existsSync(verifyData)).toBe(false);
});

test("down verify reports leftover Docker resources and keeps the state for a rerun", async () => {
  const f = await fixture();
  const verifyData = path.join(f.root, ".git/swizzle-dev-verify");
  const leftovers = path.join(f.root, "leftovers");
  await mkdir(verifyData);
  await writeFile(leftovers, "");
  await writeFile(
    path.join(f.root, "bin/docker"),
    String.raw`#!/bin/sh
if [ "$1" = compose ]; then
  printf '%s\n' "$3" > project
  exit 0
fi
[ -f leftovers ] || exit 0
for filter do :; done
[ "$filter" = "label=com.docker.compose.project=$(cat project)" ] || exit 2
case "$1" in
  ps) printf '%s\n' verify-valkey-1 ;;
  volume) printf '%s\n' verify_postgres-data verify_valkey-data ;;
  network) printf '%s\n' verify_default ;;
esac
`,
  );
  const args = ["scripts/dev-stack.mts", "down", "verify"];
  const options = { cwd: f.root, env: f.env };

  const incomplete = await invoke(process.execPath, args, options);

  expect(incomplete.status, incomplete.stderr).toBe(1);
  expect(incomplete.stdout).not.toContain("Removed");
  expect(incomplete.stderr).toContain("containers: verify-valkey-1");
  expect(incomplete.stderr).toContain("volumes: verify_postgres-data, verify_valkey-data");
  expect(incomplete.stderr).toContain("networks: verify_default");
  expect(incomplete.stderr).toContain("Rerun just dev-down to continue cleanup");
  expect(existsSync(verifyData)).toBe(true);

  await rm(leftovers);
  const retry = await invoke(process.execPath, args, options);

  expect(retry.status, retry.stderr).toBe(0);
  expect(retry.stdout).toContain("and its data.");
  expect(existsSync(verifyData)).toBe(false);
});

for (const mismatch of ["incarnation", "worktree"]) {
  test.skipIf(process.platform !== "linux")(
    `just down refuses a live process with a stale ${mismatch}`,
    async () => {
      const f = await fixture();
      const childRoot =
        mismatch === "worktree" ? await temporaryDirectory("swizzle-other-") : f.root;
      const owner = await ownedProcess(childRoot);
      await writeFile(
        path.join(f.state, "stack.json"),
        JSON.stringify({
          pid: owner.pid,
          root: f.root,
          incarnation: mismatch === "incarnation" ? "previous-process" : owner.incarnation,
          groups: [],
          project: "swizzle-test",
          ports: { web: 0 },
          login: { password: "test" },
        }),
      );
      const result = await invoke("just", ["dev-down"], { cwd: f.root, env: f.env });
      expect({
        exit: result.status,
        alive: owner.child.exitCode === null && processAlive(owner.pid),
        output: result.stdout + result.stderr,
      }).toEqual({
        exit: 1,
        alive: true,
        output: expect.stringContaining("ownership"),
      });
    },
  );
}

test.skipIf(process.platform !== "linux")(
  "just dev-down leaves dev running when the fresh stack fails its ownership check",
  async ({ signal }) => {
    const f = await fixture();
    const devOwner = await ownedProcess(
      f.root,
      `const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  writeFileSync("dev-received-sigterm", "");
  process.exit(0);
});
writeFileSync("dev-ready", "");
setInterval(() => {}, 1000);`,
    );
    const freshOwner = await ownedProcess(f.root);
    const devState = path.join(f.root, ".git/swizzle-dev");
    await mkdir(devState);
    await writeFile(
      path.join(devState, "stack.json"),
      JSON.stringify({
        pid: devOwner.pid,
        root: f.root,
        incarnation: devOwner.incarnation,
        groups: [],
      }),
    );
    await writeFile(
      path.join(f.state, "stack.json"),
      JSON.stringify({
        pid: freshOwner.pid,
        root: f.root,
        incarnation: "previous-process",
        groups: [],
      }),
    );
    await waitFor(signal, () => existsSync(path.join(f.root, "dev-ready")));

    const result = await invoke("just", ["dev-down"], { cwd: f.root, env: f.env });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Stack ownership mismatch for pid ${freshOwner.pid}`);
    expect(existsSync(path.join(f.root, "dev-received-sigterm"))).toBe(false);
    expect(processAlive(devOwner.pid)).toBe(true);
  },
);

test.skipIf(process.platform !== "linux")(
  "just dev-down refuses cleanup when the recorded orchestrator ignores SIGTERM",
  async ({ signal }) => {
    const f = await fixture();
    const owner = await ownedProcess(
      f.root,
      `process.on("SIGTERM", () => require("node:fs").writeFileSync("received-sigterm", ""));
require("node:fs").writeFileSync("ready", "");
setInterval(() => {}, 1000);`,
    );
    const record = path.join(f.state, "stack.json");
    await writeFile(
      record,
      JSON.stringify({ pid: owner.pid, root: f.root, incarnation: owner.incarnation, groups: [] }),
    );
    await waitFor(signal, () => existsSync(path.join(f.root, "ready")));

    const result = await invoke("just", ["dev-down"], { cwd: f.root, env: f.env });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Orchestrator pid ${owner.pid} survived SIGTERM`);
    expect(result.stderr).toContain(`kill -KILL ${owner.pid} and rerun just dev-down`);
    expect(existsSync(path.join(f.root, "received-sigterm"))).toBe(true);
    expect(processAlive(owner.pid)).toBe(true);
    expect(existsSync(record)).toBe(true);
  },
);

test.skipIf(process.platform !== "linux").each(["current", "reused"])(
  "down checks the orphan group leader's incarnation: %s",
  async (incarnation) => {
    const f = await fixture();
    const owner = await ownedProcess(f.root);
    const dead = await ownedProcess(f.root);
    const exited = once(dead.child, "exit");
    dead.child.kill("SIGKILL");
    await exited;
    await writeFile(
      path.join(f.state, "stack.json"),
      JSON.stringify({
        pid: dead.pid,
        root: f.root,
        incarnation: dead.incarnation,
        groups: [
          {
            pid: owner.pid,
            incarnation: incarnation === "current" ? owner.incarnation : "previous-process",
          },
        ],
        project: "swizzle-test",
        ports: { web: 0 },
        login: {},
      }),
    );
    const result = await invoke("just", ["dev-down"], { cwd: f.root, env: f.env });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(processAlive(owner.pid)).toBe(incarnation === "reused");
  },
);
