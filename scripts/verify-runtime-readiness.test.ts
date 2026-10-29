import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { heldDeadlines, temporaryDirectory, waitFor } from "../test/support.js";
import { get, type PackagedStack, startPackagedStack } from "./packaged-stack.mts";
import { verifyRuntimeReadiness } from "./verify-runtime-readiness.mts";

const state = vi.hoisted(() => ({ directories: [] as string[] }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdtemp: async (prefix: string) => {
      const directory = await fs.mkdtemp(prefix);
      if (prefix.includes("swizzle-readiness-")) state.directories.push(directory);
      return directory;
    },
  };
});
vi.mock("./packaged-stack.mts", () => ({
  get: vi.fn(),
  startPackagedStack: vi.fn(),
  until: vi.fn(),
}));

afterEach(async () => {
  for (const directory of state.directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function stack(remove: () => Promise<void>): PackagedStack {
  return {
    project: "test-stack",
    api: "http://test.invalid",
    dashboard: "http://test.invalid",
    links: "http://test.invalid",
    environment: "staging",
    envFile: "/unused",
    token: "test-token",
    session: { name: "test", value: "test" },
    cli: async () => {
      throw new Error("Unexpected CLI command");
    },
    compose: async () => {
      throw new Error("Unexpected compose command");
    },
    remove,
  };
}

it("removes its temporary directory when packaged startup fails", async () => {
  const evidence = await temporaryDirectory("readiness-evidence-");
  vi.mocked(startPackagedStack).mockRejectedValue(new Error("startup failed"));
  await expect(verifyRuntimeReadiness(evidence)).rejects.toThrow("startup failed");
  const directory = state.directories.at(-1);
  expect(typeof directory).toBe("string");
  await expect(access(directory ?? "missing")).rejects.toMatchObject({ code: "ENOENT" });
});

it.for([false, true])(
  "bounds a stalled Docker probe and removes its directory (cleanup fails: %s)",
  async (cleanupFails, { signal }) => {
    const bin = await temporaryDirectory("readiness-docker-");
    const evidence = await temporaryDirectory("readiness-evidence-");
    const started = path.join(bin, "started");
    const release = path.join(bin, "release");
    await writeFile(
      path.join(bin, "docker"),
      `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'run') {
  fs.watch(${JSON.stringify(bin)}, () => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(42); });
  fs.writeFileSync(${JSON.stringify(`${started}.tmp`)}, String(process.pid));
  fs.renameSync(${JSON.stringify(`${started}.tmp`)}, ${JSON.stringify(started)});
} else process.exit(0);
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const deadlines = heldDeadlines(60_000);
    vi.mocked(startPackagedStack).mockResolvedValue(
      stack(async () => {
        if (cleanupFails) throw new Error("stack cleanup failed");
      }),
    );
    vi.mocked(get).mockResolvedValue(
      JSON.stringify({ workers: [{ kind: "local", capabilities: {} }] }),
    );
    const running = verifyRuntimeReadiness(evidence).catch((error: unknown) => error);
    await waitFor(signal, () =>
      access(started).then(
        () => true,
        () => false,
      ),
    );
    deadlines.expire();
    await writeFile(release, "");
    expect(await running).toMatchObject(
      cleanupFails
        ? { message: "stack cleanup failed" }
        : { name: "AbortError", code: "ABORT_ERR" },
    );
    const directory = state.directories.at(-1);
    expect(typeof directory).toBe("string");
    await expect(access(directory ?? "missing")).rejects.toMatchObject({ code: "ENOENT" });
    const pid = Number(await readFile(started, "utf8"));
    await waitFor(signal, () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(pid, 0)).toThrow("ESRCH");
  },
);
