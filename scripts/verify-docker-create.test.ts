import { access, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { heldDeadlines, temporaryDirectory, waitFor } from "../test/support.js";
import { verifyDockerCreate } from "./verify-docker-create.mts";

vi.mock("@swizzle/cli", () => ({
  runCli: vi.fn(async () => {
    throw new Error("verification assertion failed");
  }),
}));

it("restores its environment and closes the proxy when Docker cleanup stalls", async ({
  signal,
}) => {
  const directory = await temporaryDirectory("create-cleanup-");
  const evidence = await temporaryDirectory("create-evidence-");
  const started = path.join(directory, "started");
  const release = path.join(directory, "release");
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
const fs = require('node:fs');
fs.watch(${JSON.stringify(directory)}, () => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(42); });
fs.writeFileSync(${JSON.stringify(`${started}.tmp`)}, JSON.stringify({ pid: process.pid, host: process.env.DOCKER_HOST }));
fs.renameSync(${JSON.stringify(`${started}.tmp`)}, ${JSON.stringify(started)});
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
  vi.stubEnv("SWIZZLE_STACK", "original-stack");
  vi.stubEnv("SWIZZLE_RUNNER_NETWORK", "original-network");
  const servers = vi.spyOn(http, "createServer");
  const deadlines = heldDeadlines(5_000);
  const running = verifyDockerCreate(evidence, "unused:image").catch((error: unknown) => error);
  try {
    await waitFor(signal, () =>
      access(started).then(
        () => true,
        () => false,
      ),
    );
    const call: { pid: number; host: string } = JSON.parse(await readFile(started, "utf8"));
    deadlines.expire();
    await writeFile(release, "");
    expect(await running).toMatchObject({ message: "verification assertion failed" });
    expect({
      host: process.env.DOCKER_HOST,
      stack: process.env.SWIZZLE_STACK,
      network: process.env.SWIZZLE_RUNNER_NETWORK,
    }).toEqual({
      host: "unix:///var/run/docker.sock",
      stack: "original-stack",
      network: "original-network",
    });
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect(Number(new URL(call.host).port), "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    expect(connected).toBe(false);
    await waitFor(signal, () => {
      try {
        process.kill(call.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(call.pid, 0)).toThrow("ESRCH");
  } finally {
    const result = servers.mock.results[0];
    if (result?.type === "return") {
      const server = result.value;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
