import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import { createWorkerRequest } from "./worker-credential.js";

const original = `swz_${"a".repeat(43)}`;

async function fixture(
  options: { loseReply?: boolean; revoked?: boolean; stall?: "probe" | "renewal" } = {},
) {
  const directory = await temporaryDirectory("swizzle-worker-credential-");
  const file = path.join(directory, "worker.env");
  await writeFile(
    file,
    `SWIZZLE_WORKER_TOKEN=${original}\nSWIZZLE_WORKER_TOKEN_EXPIRES_AT=${new Date(Date.now() + 60_000).toISOString()}\n`,
    { mode: 0o600 },
  );
  let accepted = original;
  let renewals = 0;
  let notifyStalled = () => {};
  const stalled = new Promise<void>((resolve) => {
    notifyStalled = resolve;
  });
  let release = () => {};
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    if (
      (options.stall === "probe" && req.url === "/worker/heartbeat") ||
      (options.stall === "renewal" && req.url === "/worker/token/renew")
    ) {
      notifyStalled();
      await resume;
    }
    if (options.revoked || req.headers.authorization !== `Bearer ${accepted}`) {
      res.writeHead(403).end("{}");
      return;
    }
    const worker = { tokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString() };
    let body: unknown = worker;
    if (req.url === "/worker/token/renew") {
      accepted = JSON.parse(text).token;
      renewals++;
      if (options.loseReply) {
        res.destroy();
        return;
      }
      body = { token: accepted, worker };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const origin = new URL(`http://127.0.0.1:${address.port}`);
  const start = (shutdown = new AbortController().signal) =>
    createWorkerRequest(origin, { kind: "file", path: file }, shutdown);
  return { file, start, stalled, release, renewals: () => renewals, accepted: () => accepted };
}

it("renews a due credential once across concurrent requests and restarts from the private file", async () => {
  const host = await fixture();
  const request = await host.start();
  await Promise.all([request("/worker/heartbeat", {}), request("/worker/heartbeat", {})]);
  const saved = parseEnv(await readFile(host.file, "utf8"));
  expect(host.renewals()).toBe(1);
  expect(saved.SWIZZLE_WORKER_TOKEN).toBe(host.accepted());
  expect(saved.SWIZZLE_WORKER_TOKEN).not.toBe(original);
  expect((await stat(host.file)).mode & 0o777).toBe(0o600);
  expect(Date.parse(saved.SWIZZLE_WORKER_TOKEN_EXPIRES_AT ?? "") - Date.now()).toBeGreaterThan(
    89 * 24 * 60 * 60_000,
  );
  const restarted = await host.start();
  await restarted("/worker/heartbeat", {});
  expect(host.renewals()).toBe(1);
});

it("recovers the saved candidate after the server rotated but its reply was lost", async () => {
  const host = await fixture({ loseReply: true });
  const request = await host.start();
  await expect(request("/worker/heartbeat", {})).rejects.toThrow();
  const interrupted = parseEnv(await readFile(host.file, "utf8"));
  expect(interrupted.SWIZZLE_WORKER_TOKEN).toBe(original);
  expect(interrupted.SWIZZLE_WORKER_PENDING_TOKEN).toBe(host.accepted());
  const restarted = await host.start();
  await restarted("/worker/heartbeat", {});
  const saved = parseEnv(await readFile(host.file, "utf8"));
  expect(saved.SWIZZLE_WORKER_TOKEN).toBe(host.accepted());
  expect(saved.SWIZZLE_WORKER_PENDING_TOKEN).toBeUndefined();
  expect(host.renewals()).toBe(1);
});

it("refuses renewal for a revoked identity while a live identity can renew", async () => {
  const host = await fixture({ revoked: true });
  const request = await host.start();
  await expect(request("/worker/heartbeat", {})).rejects.toThrow("failed (403)");
  expect(host.renewals()).toBe(0);
  expect(parseEnv(await readFile(host.file, "utf8")).SWIZZLE_WORKER_TOKEN).toBe(original);
  const live = await fixture();
  await (await live.start())("/worker/heartbeat", {});
  expect(live.renewals()).toBe(1);
});

it("persists a candidate again after an initial save failure before recovering a lost reply", async () => {
  const host = await fixture({ loseReply: true });
  const request = await host.start();
  const directory = path.dirname(host.file);
  const moved = `${directory}.offline`;
  await rename(directory, moved);
  try {
    await expect(request("/worker/heartbeat", {})).rejects.toThrow();
    expect(host.renewals()).toBe(0);
  } finally {
    await rename(moved, directory);
  }
  await expect(request("/worker/heartbeat", {})).rejects.toThrow();
  expect(host.renewals()).toBe(1);
  const saved = parseEnv(await readFile(host.file, "utf8"));
  expect(saved.SWIZZLE_WORKER_PENDING_TOKEN).toBe(host.accepted());
  const restarted = await host.start();
  await restarted("/worker/heartbeat", {});
  expect(parseEnv(await readFile(host.file, "utf8")).SWIZZLE_WORKER_TOKEN).toBe(host.accepted());
});

it("cancels one caller waiting for rotation while other callers finish that rotation", async () => {
  const host = await fixture({ stall: "probe" });
  const request = await host.start();
  const caller = new AbortController();
  const canceled = request("/worker/pull", {}, caller.signal).then(
    () => false,
    (error) => error.message === "caller canceled",
  );
  const continuing = request("/worker/heartbeat", {});
  void continuing.catch(() => {});
  await host.stalled;
  caller.abort(new Error("caller canceled"));
  expect(await Promise.race([canceled, delay(1000).then(() => false)])).toBe(true);
  host.release();
  await continuing;
  expect(host.renewals()).toBe(1);
  expect(parseEnv(await readFile(host.file, "utf8")).SWIZZLE_WORKER_TOKEN).toBe(host.accepted());
});

it.for(["probe", "renewal"] as const)(
  "shutdown cancels a stalled token %s and permits drain with the current token",
  async (stall) => {
    const host = await fixture({ stall });
    const shutdown = new AbortController();
    const request = await host.start(shutdown.signal);
    const canceled = request("/worker/heartbeat", {}).then(
      () => false,
      (error) => error.message === "worker closing",
    );
    await host.stalled;
    shutdown.abort(new Error("worker closing"));
    expect(await Promise.race([canceled, delay(1000).then(() => false)])).toBe(true);
    // Drain does not wait on or start another credential rotation during shutdown.
    await request("/worker/drain", { draining: true });
    expect(host.renewals()).toBe(0);
    host.release();
  },
);
