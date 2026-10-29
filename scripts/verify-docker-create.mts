// Holds real Docker create replies past the metadata budget, then withholds them to prove the bound.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { runCli } from "@swizzle/cli";

export async function verifyDockerCreate(evidence: string, baseImage: string): Promise<void> {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-create-proof-"));
  let mode: "delayed" | "stalled" = "delayed";
  const replies: { mode: string; requested: string; received: string; delivered?: string }[] = [];
  const sockets = new Set<net.Socket>();
  const socketPath = process.env.DOCKER_HOST?.startsWith("unix://")
    ? process.env.DOCKER_HOST.slice(7)
    : "/var/run/docker.sock";
  const proxy = http.createServer((request, response) => {
    const requested = new Date().toISOString();
    const upstream = http.request(
      { socketPath, path: request.url, method: request.method, headers: request.headers },
      (answer) => {
        const create = request.method === "POST" && request.url?.includes("/containers/create");
        const reply = create ? { mode, requested, received: new Date().toISOString() } : undefined;
        if (reply) replies.push(reply);
        const send = () => {
          if (response.destroyed) return;
          if (reply) Object.assign(reply, { delivered: new Date().toISOString() });
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        };
        // This is a fault injector, not a test wait: the real CLI must outlive its former deadline.
        if (create && mode === "delayed") void delay(6_000).then(send);
        else if (!create) send();
        response.once("close", () => answer.destroy());
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  proxy.on("upgrade", (request, client, head) => {
    // Node delivers an upgrade request's JSON body through IncomingMessage, not the raw head.
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.once("end", () => {
      const upstream = http.request({
        socketPath,
        path: request.url,
        method: request.method,
        headers: request.headers,
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.on("upgrade", (answer, stream, upstreamHead) => {
        sockets.add(stream);
        stream.once("close", () => sockets.delete(stream));
        stream.on("error", () => client.destroy());
        client.once("close", () => stream.destroy());
        client.write(
          `HTTP/1.1 101 ${answer.statusMessage}\r\n${answer.rawHeaders.reduce((lines, value, index, all) => (index % 2 === 0 ? `${lines}${value}: ${all[index + 1]}\r\n` : lines), "")}\r\n`,
        );
        client.write(upstreamHead);
        stream.write(head);
        client.pipe(stream).pipe(client);
      });
      upstream.on("response", (answer) => {
        client.write(
          `HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\nConnection: close\r\n\r\n`,
        );
        answer.pipe(client);
      });
      upstream.end(Buffer.concat(body));
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const priorHost = process.env.DOCKER_HOST;
  const priorStack = process.env.SWIZZLE_STACK;
  const priorNetwork = process.env.SWIZZLE_RUNNER_NETWORK;
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${address.port}`;
  process.env.SWIZZLE_STACK = `create-proof-${randomUUID()}`;
  process.env.SWIZZLE_RUNNER_NETWORK = "none";
  const run = async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["run", directory, "--json"], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
    });
    return { code, output: JSON.parse(stdout), stderr };
  };
  let failure: { readonly error: unknown } | undefined;
  try {
    await writeFile(
      path.join(directory, "config.yaml"),
      `name: create-proof\nversion: 1.0.0\nentrypoint: main.js\ntrigger: { type: webhook }\nruntime:\n  execution_mode: container\n  timeout: 2m\n  container: { base_image: ${baseImage} }\n  permissions: { network: false }\n`,
    );
    await writeFile(path.join(directory, "main.js"), "console.log(JSON.stringify({ok:true}));\n");
    const completed = await run();
    await writeFile(
      path.join(evidence, "A5-delayed-create.json"),
      JSON.stringify({ completed, replies }, null, 2),
    );
    assert.equal(completed.code, 0, JSON.stringify(completed));
    assert.ok(replies.length >= 2, "assembly and sandbox create replies were held");
    mode = "stalled";
    await writeFile(
      path.join(directory, "main.js"),
      "console.log(JSON.stringify({changed:true}));\n",
    );
    const stalled = await run();
    await writeFile(
      path.join(evidence, "A5-stalled-daemon.json"),
      JSON.stringify({ stalled, replies }, null, 2),
    );
    assert.notEqual(stalled.code, 0);
    assert.match(JSON.stringify(stalled.output), /DOCKER_TRANSFER_TIMEOUT/u);
  } catch (error) {
    failure = { error };
  } finally {
    // Keep cleanup on the same private namespace, but let its control calls through.
    mode = "delayed";
    try {
      const exec = promisify(execFile);
      const images = (
        await exec(
          "docker",
          [
            "image",
            "ls",
            "--all",
            "--quiet",
            "--filter",
            `label=swizzle.stack=local-${process.env.SWIZZLE_STACK}`,
          ],
          {
            signal: AbortSignal.timeout(5_000),
            killSignal: "SIGKILL",
          },
        )
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean);
      if (images.length > 0)
        await exec("docker", ["image", "rm", "--force", ...images], {
          signal: AbortSignal.timeout(5_000),
          killSignal: "SIGKILL",
        });
    } catch (error) {
      if (failure === undefined) failure = { error };
      else process.stderr.write(`Docker cleanup failed: ${String(error)}\n`);
    } finally {
      if (priorHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = priorHost;
      if (priorStack === undefined) delete process.env.SWIZZLE_STACK;
      else process.env.SWIZZLE_STACK = priorStack;
      if (priorNetwork === undefined) delete process.env.SWIZZLE_RUNNER_NETWORK;
      else process.env.SWIZZLE_RUNNER_NETWORK = priorNetwork;
      for (const socket of sockets) socket.destroy();
      try {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  if (failure !== undefined) throw failure.error;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await verifyDockerCreate(
    path.resolve(process.argv[2] ?? "."),
    process.argv[3] ?? "node:26.12.1-trixie-slim",
  );
}
