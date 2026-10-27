import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { fixture, invoke, ownedProcess, processAlive } from "../test/dev-stack.js";
import { temporaryDirectory } from "../test/support.js";

for (const mismatch of ["incarnation", "worktree"]) {
  test.skipIf(process.platform !== "linux")(
    `just down refuses a live process with a stale ${mismatch}`,
    async () => {
      const f = await fixture();
      // The substring used by the old owner check is present, just as for a reused orchestrator PID.
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
