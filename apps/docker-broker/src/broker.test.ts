// The broker in front of a fake Docker daemon on a Unix socket. cli-requests.json holds the bodies
// the worker image's Docker CLI (29.9.2) sends for the sandbox and image assembly creates and for
// a run's exec, captured with the arguments packages/runtime builds.
import { execFile } from "node:child_process";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { containerLimitArguments } from "@swizzle/runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { heldDeadlines, temporaryDirectory, waitFor } from "../../../test/support.js";
import { createBroker } from "./broker.js";
import requests from "./cli-requests.json" with { type: "json" };
import { readBrokerScope } from "./policy.js";

const exec = promisify(execFile);

const OWNED_ID = "a".repeat(64);
const FOREIGN_ID = "b".repeat(64);
const SECOND_OWNED_ID = "c".repeat(64);

interface Received {
  readonly method: string;
  readonly url: string;
  body: string;
}

/** The fake daemon never answers a lookup of this container, like a daemon that stopped answering. */
const STALLED = "swizzle-run-stalled";

/**
 * A broker for stack-a, the requests that reached the daemon behind it, and the `METHOD url` of
 * each daemon request whose connection closed before the daemon answered it in full.
 */
async function startBroker(): Promise<{
  readonly url: string;
  readonly received: Received[];
  readonly abandoned: string[];
}> {
  const socketPath = path.join(await temporaryDirectory("docker-broker-"), "docker.sock");
  const received: Received[] = [];
  const abandoned: string[] = [];
  const daemon = createServer({ maxHeaderSize: 1_048_576 }, (req, res) => {
    res.on("close", () => {
      if (!res.writableFinished) abandoned.push(`${req.method} ${req.url}`);
    });
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      received.push({ body, method: req.method ?? "", url: req.url ?? "" });
      // Like the daemon's wait: headers at once, the body when the container exits.
      if (req.url?.includes("/wait")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        return;
      }
      if (req.url?.includes("/images/get?")) {
        res.writeHead(200, { "content-type": "application/x-tar" });
        res.end(Buffer.alloc(1024));
        return;
      }
      if (req.url?.endsWith("/history")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              Id: OWNED_ID,
              Created: 0,
              CreatedBy: "COPY fixture",
              Size: 2097152,
              Tags: [],
              Comment: "",
            },
          ]),
        );
        return;
      }
      const inspected = /\/(?:containers|images)\/(\w[\w.-]*)\/json$/u.exec(req.url ?? "")?.[1];
      if (inspected === STALLED) return;
      res.writeHead(inspected === undefined ? 201 : 200, { "content-type": "application/json" });
      if (inspected === undefined) res.end("{}");
      else if (
        inspected === "swizzle-run-1" ||
        inspected === OWNED_ID ||
        inspected === SECOND_OWNED_ID
      )
        res.end(
          JSON.stringify({ Config: { Labels: { "swizzle.stack": "stack-a" } }, Id: OWNED_ID }),
        );
      else res.end(JSON.stringify({ Config: { Labels: {} }, Id: FOREIGN_ID }));
    });
  });
  // Like the daemon on a call it does not hijack: an ordinary answer on a connection that stays
  // open. The request body and every byte that reaches it after the request are recorded as the
  // body; Node delivers the first on the request and the rest on the socket.
  const raw = new Set<Socket>();
  daemon.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    raw.add(socket);
    const entry = { body: "", method: req.method ?? "", url: req.url ?? "" };
    received.push(entry);
    const record = (chunk: Buffer) => {
      entry.body += chunk.toString("utf8");
    };
    req.on("data", record);
    record(head);
    // stdin=1 marks a call the daemon switches, as for an attach: once the request body is in, it
    // answers 101 and echoes the raw stream. Bytes before the switch stay in the recorded body.
    if (req.url?.includes("stdin=1") === true) {
      let switched = false;
      socket.on("data", (chunk: Buffer) => {
        if (switched) socket.write(`echo:${chunk.toString("utf8")}`);
        else record(chunk);
      });
      req.on("end", () => {
        switched = true;
        socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nready;");
      });
      return;
    }
    socket.on("data", record);
    // stdout=1 marks an answer whose body never finishes.
    const unfinished = req.url?.includes("stdout=1") === true;
    // The broker's end of this connection closing reaches the fake as its end.
    socket.once("end", () => {
      if (unfinished) abandoned.push(`${req.method} ${req.url}`);
    });
    socket.write(
      `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n${unfinished ? "{" : "{}"}`,
    );
  });
  daemon.listen(socketPath);
  await once(daemon, "listening");
  const broker = createBroker({
    scope: {
      maxMemoryBytes: 2048 * 1_048_576,
      maxNanoCpus: 2_000_000_000,
      runnerNetwork: "stack-a_runner-egress",
      stack: "stack-a",
    },
    socketPath,
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  onTestFinished(async () => {
    for (const socket of raw) socket.destroy();
    await Promise.all([close(broker), close(daemon)]);
  });
  return {
    abandoned,
    received,
    url: `http://127.0.0.1:${(broker.address() as AddressInfo).port}`,
  };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function without<T extends object>(value: T, key: keyof T): Omit<T, typeof key> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}

/** Writes raw bytes to the broker and returns everything it answers until it closes. */
async function rawExchange(url: string, bytes: string): Promise<string> {
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  await once(socket, "connect");
  socket.write(bytes);
  let answer = "";
  for await (const chunk of socket) answer += String(chunk);
  return answer;
}

function withHostConfig(change: Record<string, unknown>): unknown {
  return { ...requests.sandbox, HostConfig: { ...requests.sandbox.HostConfig, ...change } };
}

it("allows image history only for images owned by the stack", async () => {
  const { url, received } = await startBroker();
  const route = `/images/${OWNED_ID}/history`;
  vi.stubEnv("DOCKER_CONTEXT", "swizzle-unavailable-test-context");
  vi.stubEnv("DOCKER_TLS", "1");
  vi.stubEnv("DOCKER_TLS_VERIFY", "1");
  vi.stubEnv("DOCKER_CERT_PATH", await temporaryDirectory("docker-inherited-certs-"));
  const { stdout } = await exec(
    "docker",
    ["image", "history", "--human=false", "--no-trunc", "--format", "{{.Size}}", OWNED_ID],
    {
      env: {
        PATH: process.env.PATH,
        DOCKER_CONFIG: await temporaryDirectory("docker-cli-config-"),
        DOCKER_HOST: url.replace("http:", "tcp:"),
      },
    },
  );
  expect(stdout).toBe("2097152\n");
  expect(
    received.map((call) => ({ ...call, url: call.url.replace(/^\/v\d+\.\d+/u, "") })),
  ).toContainEqual({ method: "GET", url: route, body: "" });
  expect((await fetch(`${url}/v1.52/images/${FOREIGN_ID}/history`)).status).toBe(403);
  expect(received).not.toContainEqual({
    method: "GET",
    url: `/v1.52/images/${FOREIGN_ID}/history`,
    body: "",
  });
});

it("exports the CLI's image set only when every image belongs to the stack", async () => {
  const { url, received } = await startBroker();
  const { stdout } = await exec("docker", ["image", "save", OWNED_ID, SECOND_OWNED_ID], {
    encoding: "buffer",
    env: {
      PATH: process.env.PATH,
      DOCKER_CONFIG: await temporaryDirectory("docker-cli-save-config-"),
      DOCKER_HOST: url.replace("http:", "tcp:"),
    },
  });
  expect(stdout).toEqual(Buffer.alloc(1024));
  const exported = `/images/get?names=${OWNED_ID}&names=${SECOND_OWNED_ID}`;
  expect(
    received.map((call) => ({ ...call, url: call.url.replace(/^\/v\d+\.\d+/u, "") })),
  ).toContainEqual({ method: "GET", url: exported, body: "" });
  const refused = `/images/get?names=${OWNED_ID}&names=${FOREIGN_ID}`;
  expect((await fetch(`${url}${refused}`)).status).toBe(403);
  expect(received).not.toContainEqual({ method: "GET", url: refused, body: "" });
  for (const route of [
    "/images/get",
    "/images/get?names=node:latest",
    `/images/get?names=${OWNED_ID}&unexpected=true`,
  ]) {
    expect((await fetch(`${url}${route}`)).status).toBe(403);
  }
});

describe("docker-broker", () => {
  it.each([
    ["the f-204 probe", withHostConfig({ Binds: ["/:/host:ro"], Privileged: true })],
    ["a host bind", withHostConfig({ Binds: ["/etc:/host-etc:ro"] })],
    ["a host mount", withHostConfig({ Mounts: [{ Source: "/", Target: "/host", Type: "bind" }] })],
    [
      "a device",
      withHostConfig({ Devices: [{ PathInContainer: "/dev/sda", PathOnHost: "/dev/sda" }] }),
    ],
    ["an added capability", withHostConfig({ CapAdd: ["SYS_ADMIN"] })],
    ["the host pid namespace", withHostConfig({ PidMode: "host" })],
    ["the host network", withHostConfig({ NetworkMode: "host" })],
    ["another container's network", withHostConfig({ NetworkMode: "container:postgres" })],
    ["no seccomp profile", withHostConfig({ SecurityOpt: ["seccomp=unconfined"] })],
    ["unmasked /proc paths", withHostConfig({ MaskedPaths: [] })],
    ["a field the worker never sets", withHostConfig({ Sysctls: { "kernel.shmmax": "1" } })],
    ["the root user", { ...requests.sandbox, User: "0:0" }],
    ["no stack label", { ...requests.sandbox, Labels: {} }],
    ["no user, so the image's", without(requests.sandbox, "User")],
    ["no labels", without(requests.sandbox, "Labels")],
    ["no host config", without(requests.sandbox, "HostConfig")],
    [
      "no dropped capabilities",
      { ...requests.sandbox, HostConfig: without(requests.sandbox.HostConfig, "CapDrop") },
    ],
    [
      "no no-new-privileges",
      { ...requests.sandbox, HostConfig: without(requests.sandbox.HostConfig, "SecurityOpt") },
    ],
    [
      "no network mode, so the bridge",
      { ...requests.sandbox, HostConfig: without(requests.sandbox.HostConfig, "NetworkMode") },
    ],
    // f-232: a zero or missing limit is Docker's unlimited.
    ["no memory limit", withHostConfig({ Memory: 0, MemorySwap: 0 })],
    ["no CPU limit", withHostConfig({ NanoCpus: 0 })],
    ["no PID limit", withHostConfig({ PidsLimit: 0 })],
    [
      "no ulimits",
      { ...requests.sandbox, HostConfig: without(requests.sandbox.HostConfig, "Ulimits") },
    ],
    ["null ulimits", withHostConfig({ Ulimits: null })],
    [
      "memory above the platform maximum",
      withHostConfig({ Memory: 4096 * 1_048_576, MemorySwap: 4096 * 1_048_576 }),
    ],
    ["CPUs above the platform maximum", withHostConfig({ NanoCpus: 3_000_000_000 })],
    [
      "a looser open-files limit",
      withHostConfig({ Ulimits: [{ Hard: 65_536, Name: "nofile", Soft: 65_536 }] }),
    ],
  ])("refuses a create with %s and never passes it on", async (_name, body) => {
    const broker = await startBroker();

    const response = await post(`${broker.url}/v1.56/containers/create?name=probe`, body);

    expect(response.status).toBe(403);
    expect(broker.received).toEqual([]);
  });

  it("passes on the sandbox and image assembly creates the worker sends", async () => {
    const broker = await startBroker();

    for (const body of [requests.sandbox, requests.assembly]) {
      const response = await post(`${broker.url}/v1.56/containers/create?name=swizzle-run-1`, body);
      expect(response.status).toBe(201);
    }

    expect(broker.received.map(({ body }) => JSON.parse(body))).toEqual([
      requests.sandbox,
      requests.assembly,
    ]);
  });

  it.each([
    ["missing", undefined],
    ["infinite", "Infinity"],
    ["overflowing", "1e309"],
    ["too large to count in bytes", "1e300"],
    ["zero", "0"],
  ])("refuses to start with a %s platform maximum", (_name, value) => {
    const environment = {
      SWIZZLE_MAX_RUN_CPUS: "2",
      SWIZZLE_MAX_RUN_MEMORY_MB: "2048",
      SWIZZLE_RUNNER_NETWORK: "stack-a_runner-egress",
      SWIZZLE_STACK: "stack-a",
    };

    expect(readBrokerScope(environment)).toMatchObject({ maxMemoryBytes: 2048 * 1_048_576 });
    expect(readBrokerScope({ ...environment, SWIZZLE_MAX_RUN_MEMORY_MB: value })).toContain(
      "SWIZZLE_MAX_RUN_MEMORY_MB must be a positive number",
    );
    expect(readBrokerScope({ ...environment, SWIZZLE_MAX_RUN_CPUS: value })).toContain(
      "SWIZZLE_MAX_RUN_CPUS must be a positive number",
    );
  });

  // The broker holds a create to the limits packages/runtime sends, which the recording carries.
  it("expects the limits the runtime's container arguments ask for", () => {
    const limits = containerLimitArguments({});
    const host = requests.sandbox.HostConfig;

    expect(limits).toEqual([
      "--pids-limit",
      String(host.PidsLimit),
      "--ulimit",
      `nofile=${host.Ulimits[0]?.Soft}:${host.Ulimits[0]?.Hard}`,
      "--memory",
      `${host.Memory / 1_048_576}m`,
      "--memory-swap",
      `${host.MemorySwap / 1_048_576}m`,
      "--cpus",
      (host.NanoCpus / 1e9).toFixed(1),
    ]);
    expect(requests.assembly.HostConfig).toMatchObject({
      Memory: host.Memory,
      MemorySwap: host.MemorySwap,
      NanoCpus: host.NanoCpus,
      PidsLimit: host.PidsLimit,
      Ulimits: host.Ulimits,
    });
  });

  it("lists containers only by this stack's label or its workers' label", async () => {
    const broker = await startBroker();
    const list = (filters: unknown) =>
      fetch(
        `${broker.url}/v1.56/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`,
      ).then((response) => response.status);

    const statuses = [
      await list({ label: { "swizzle.stack=stack-b": true } }),
      await list({ label: { "swizzle.stack=stack-a": true, "swizzle.worker-of=stack-b": true } }),
      await list({ label: { "swizzle.stack=stack-a": true }, name: { postgres: true } }),
      await fetch(`${broker.url}/v1.56/containers/json?all=1`).then((response) => response.status),
      await list({ label: { "swizzle.stack=stack-a": true } }),
      await list({ label: { "swizzle.worker-of=stack-a": true } }),
    ];

    expect(statuses).toEqual([403, 403, 403, 403, 201, 201]);
    expect(broker.received).toHaveLength(2);
  });

  it("runs an exec only in a container of its stack, by id and without privileges", async () => {
    const broker = await startBroker();

    const foreign = await post(`${broker.url}/v1.56/containers/postgres/exec`, requests.exec);
    const privileged = await post(`${broker.url}/v1.56/containers/swizzle-run-1/exec`, {
      ...requests.exec,
      Privileged: true,
    });
    const owned = await post(`${broker.url}/v1.56/containers/swizzle-run-1/exec`, requests.exec);

    expect([foreign.status, privileged.status, owned.status]).toEqual([403, 403, 201]);
    expect(broker.received.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET /containers/postgres/json",
      "GET /containers/swizzle-run-1/json",
      "GET /containers/swizzle-run-1/json",
      `POST /v1.56/containers/${OWNED_ID}/exec`,
    ]);
  });

  it("passes on a wait's headers before its body, which docker start --attach waits for", async ({
    signal,
  }) => {
    const broker = await startBroker();

    // A broker that held the headers for the body would hold this fetch until the test timeout.
    const response = await fetch(`${broker.url}/v1.56/containers/swizzle-run-1/wait`, {
      method: "POST",
      signal,
    });

    expect(response.status).toBe(200);
  });

  it("refuses a create that asks for a raw stream, which would skip its body check", async () => {
    const broker = await startBroker();
    const body = JSON.stringify(withHostConfig({ Privileged: true }));

    const answer = await rawExchange(
      broker.url,
      `POST /v1.56/containers/create HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );

    expect(answer).toMatch(/^HTTP\/1\.1 403 /u);
    expect(broker.received).toEqual([]);
  });

  it("passes nothing after an allowed raw-stream call that the daemon does not switch", async () => {
    const broker = await startBroker();
    const create = JSON.stringify(withHostConfig({ Privileged: true }));

    const answer = await rawExchange(
      broker.url,
      `POST /v1.56/containers/swizzle-run-1/attach?stream=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n` +
        `POST /v1.56/containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(create)}\r\n\r\n${create}`,
    );

    expect(answer).toMatch(/^HTTP\/1\.1 200 /u);
    expect(broker.received).toEqual([
      { body: "", method: "GET", url: "/containers/swizzle-run-1/json" },
      { body: "", method: "POST", url: `/v1.56/containers/${OWNED_ID}/attach?stream=1` },
    ]);
  });

  // The client may send its stream before the switch; the daemon must see it only after the switch.
  it("hands a switched raw stream its request body once, then bytes in both directions", async ({
    signal,
  }) => {
    const broker = await startBroker();
    const socket = connect(Number(new URL(broker.url).port), "127.0.0.1");
    await once(socket, "connect");
    let answer = "";
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString("utf8");
    });

    socket.write(
      "POST /v1.56/containers/swizzle-run-1/attach?stream=1&stdin=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 10\r\n\r\nbody-",
    );
    await waitFor(signal, () => broker.received.length === 1);
    socket.write("part|early|");
    await waitFor(signal, () => answer.includes("echo:early|"));
    socket.write("late|");
    await waitFor(signal, () => answer.includes("echo:late|"));
    socket.destroy();

    expect(answer).toMatch(
      /^HTTP\/1\.1 101 UPGRADED\r\n[\s\S]*\r\n\r\nready;echo:early\|echo:late\|$/u,
    );
    expect(broker.received).toEqual([
      { body: "", method: "GET", url: "/containers/swizzle-run-1/json" },
      {
        body: "body-part|",
        method: "POST",
        url: `/v1.56/containers/${OWNED_ID}/attach?stream=1&stdin=1`,
      },
    ]);
  });

  // A worker CLI that times out or is killed disconnects; what it asked of the daemon must end too.
  it.for([
    {
      call: "POST /v1.56/containers/swizzle-run-1/wait",
      daemonPath: `/v1.56/containers/${OWNED_ID}/wait`,
      headers: "",
      request: "a forwarded wait",
    },
    {
      call: `POST /v1.56/containers/${STALLED}/stop`,
      daemonPath: `/containers/${STALLED}/json`,
      headers: "",
      request: "an ownership lookup",
    },
    {
      call: `POST /v1.56/containers/${STALLED}/attach?stream=1`,
      daemonPath: `/containers/${STALLED}/json`,
      headers: "Connection: Upgrade\r\nUpgrade: tcp\r\n",
      request: "the lookup of a raw-stream call",
    },
    {
      call: "POST /v1.56/containers/swizzle-run-1/attach?stream=1&stdout=1",
      daemonPath: `/v1.56/containers/${OWNED_ID}/attach?stream=1&stdout=1`,
      headers: "Connection: Upgrade\r\nUpgrade: tcp\r\n",
      request: "a raw-stream call the daemon answers without switching",
    },
  ])(
    "closes the daemon request of $request when its client disconnects",
    async ({ call, daemonPath, headers }, { signal }) => {
      const broker = await startBroker();
      const client = connect(Number(new URL(broker.url).port), "127.0.0.1");
      await once(client, "connect");
      client.write(`${call} HTTP/1.1\r\nHost: docker\r\n${headers}Content-Length: 0\r\n\r\n`);
      await waitFor(signal, () => broker.received.some(({ url }) => url === daemonPath));

      client.destroy();

      await waitFor(signal, () => broker.abandoned.some((request) => request.endsWith(daemonPath)));
    },
  );

  it("answers 504 when the daemon does not answer an ownership lookup in time", async ({
    signal,
  }) => {
    const broker = await startBroker();
    const lookups = heldDeadlines(5_000);

    const answer = fetch(`${broker.url}/v1.56/containers/${STALLED}/stop`, { method: "POST" });
    await waitFor(signal, () => broker.received.length === 1);
    lookups.expire();

    const response = await answer;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      message: `docker-broker: the daemon did not answer GET /containers/${STALLED}/json within 5 seconds`,
    });
    await waitFor(signal, () => broker.abandoned.includes(`GET /containers/${STALLED}/json`));
  });

  it("answers a malformed request target with 400 and keeps serving", async () => {
    const broker = await startBroker();

    const answer = await rawExchange(
      broker.url,
      "GET http://[::1/ HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n",
    );
    const ping = await fetch(`${broker.url}/_ping`);

    expect(answer).toMatch(/^HTTP\/1\.1 400 /u);
    expect(ping.status).toBe(201);
  });
});
