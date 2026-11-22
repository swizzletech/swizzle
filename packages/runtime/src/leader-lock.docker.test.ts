import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { waitFor } from "../../../test/support.js";
import { createLeaderLock } from "./leader-lock.js";

const docker = promisify(execFile);

it("ends the isolated scheduler's admission before its peer acquires leadership", async ({
  signal,
}) => {
  const name = `swizzle-leader-test-${randomUUID()}`;
  const services = await readFile("infra/docker/databases.yml", "utf8");
  const image = /^ {4}image: (valkey\/\S+)$/mu.exec(services)?.[1];
  if (image === undefined) throw new Error("The stack has no Valkey image.");
  await docker("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::6379",
    image,
  ]);
  try {
    const { stdout } = await docker("docker", ["port", name, "6379/tcp"]);
    const address = stdout.trim();
    const direct = `redis://${address}`;
    const port = Number(address.split(":").at(-1));
    await waitFor(signal, async () => {
      const reply = await docker("docker", ["exec", name, "valkey-cli", "ping"]).catch(() => null);
      return reply?.stdout.trim() === "PONG";
    });
    const sockets = new Set<Socket>();
    let isolated = false;
    const proxy = createServer((socket) => {
      if (isolated) {
        socket.destroy();
        return;
      }
      const upstream = createConnection({ host: "127.0.0.1", port });
      sockets.add(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
      socket.on("close", () => {
        sockets.delete(socket);
        upstream.destroy();
      });
      socket.pipe(upstream).pipe(socket);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const lock = { key: "swizzle:test:leader", ttlMs: 3_000, renewIntervalMs: 100 };
    const first = createLeaderLock({
      ...lock,
      instanceId: "one",
      valkeyUrl: `redis://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    });
    const second = createLeaderLock({ ...lock, instanceId: "two", valkeyUrl: direct });
    try {
      await first.start();
      expect(first.isLeader()).toBe(true);
      await second.start();
      expect(second.isLeader()).toBe(false);
      isolated = true;
      for (const socket of sockets) socket.destroy();
      await waitFor(signal, () => second.isLeader());
      expect(first.isLeader()).toBe(false);

      isolated = false;
      await second.close();
      await waitFor(signal, () => first.isLeader());
    } finally {
      isolated = false;
      try {
        await Promise.all([first.close(), second.close()]);
      } finally {
        proxy.close();
        for (const socket of sockets) socket.destroy();
      }
    }
  } finally {
    await docker("docker", ["rm", "--force", "--volumes", name]);
  }
});
