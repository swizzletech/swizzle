import { EventEmitter, once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { temporaryDirectory } from "../../../test/support.js";
import {
  closeServer,
  createBufferIO,
  listenOnRandomPort,
  withoutProfile,
} from "../test/cli-harness.js";
import { runCli } from "./main.js";
import { saveProfileConfig } from "./profile.js";

async function pointProfileAt(url: string): Promise<void> {
  await withoutProfile();
  vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
  await saveProfileConfig({
    profiles: { loopback: { name: "loopback", url, token: "fixture-token" } },
  });
}

it.each(["", "{}", '{"environments":[{"name":"staging","hasData":true,"liveServices":[null]}]}'])(
  "reports an invalid API response when status discovers environments from %j",
  async (body) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    const url = await listenOnRandomPort(server);
    onTestFinished(() => closeServer(server));
    await pointProfileAt(url);

    const io = createBufferIO();
    const exit = await runCli(["status", "--profile", "loopback", "--json"], io);

    expect(requests).toEqual(["/environments"]);
    expect({ exit, output: JSON.parse(io.stdoutText) }).toMatchObject({
      exit: 5,
      output: {
        code: "INVALID_API_RESPONSE",
        details: { httpStatus: 200, url },
        help: [expect.stringContaining(`${url}/api`)],
      },
    });
    expect(io.stderrText).toBe("");
  },
);

it("uses the shared environment error for apply and the home view", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const url = await listenOnRandomPort(server);
  onTestFinished(() => closeServer(server));
  await pointProfileAt(url);
  const directory = await temporaryDirectory("swizzle-environment-response-");
  await writeFile(
    path.join(directory, "config.yaml"),
    `name: environment-response
version: 1.0.0
entrypoint: main.js
trigger: { type: webhook, path: /hooks/environment-response }
`,
  );
  await writeFile(path.join(directory, "main.js"), "console.log('{}');\n");
  const target = ["--profile", "loopback", "--json"];
  const apply = createBufferIO();
  const home = createBufferIO();

  expect(await runCli(["apply", directory, ...target], apply)).toBe(5);
  expect(JSON.parse(apply.stdoutText)).toMatchObject({
    code: "INVALID_API_RESPONSE",
    help: [expect.stringContaining(`${url}/api`)],
  });
  expect(await runCli(target, home)).toBe(0);
  expect(JSON.parse(home.stdoutText)).toMatchObject({
    target: `unavailable: ${url} does not answer as a Swizzle API. The body did not match the requested endpoint.`,
  });
  expect(requests).toEqual(["/environments", "/environments"]);
});

it.each([
  { health: { service: "api", version: "1.2.3" }, serverVersion: "1.2.3" },
  { health: { service: "api" }, serverVersion: null },
])("doctor accepts the health fields it uses from $health", async ({ health, serverVersion }) => {
  const replies: Record<string, unknown> = {
    "/health": health,
    "/ready": { checks: {} },
    "/dashboard/automations": { automations: [] },
    "/secrets": { environment: "staging", secrets: [] },
    "/connections": { environment: "staging", connections: [] },
  };
  const server = createServer((request, response) => {
    const route = request.url?.split("?")[0] ?? "/";
    const body = replies[route];
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const url = await listenOnRandomPort(server);
  onTestFinished(() => closeServer(server));
  await pointProfileAt(url);
  const io = createBufferIO();

  const exit = await runCli(["doctor", "-e", "staging", "--profile", "loopback", "--json"], io);

  expect({ exit, output: JSON.parse(io.stdoutText) }).toMatchObject({
    exit: 0,
    output: { result: "all checks passed", serverVersion },
  });
});

it.each(["deadline expires", "server disconnects"])(
  "reports a transport error when the response stalls and the %s",
  async (failure) => {
    const responseEvents = new EventEmitter();
    const bodyReading = once(responseEvents, "reading");
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await fetch(...args);
      const text = response.text.bind(response);
      vi.spyOn(response, "text").mockImplementationOnce(() => {
        const body = text();
        responseEvents.emit("reading");
        return body;
      });
      return response;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    const io = createBufferIO();
    const url = await listenOnRandomPort(server);
    onTestFinished(async () => {
      vi.useRealTimers();
      server.closeAllConnections();
      await closeServer(server);
    });
    await pointProfileAt(url);
    if (failure === "deadline expires")
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const command = runCli(["worker", "list", "--profile", "loopback", "--json"], io);
    await bodyReading;
    if (failure === "deadline expires") {
      await vi.advanceTimersByTimeAsync(30_000);
    } else {
      server.closeAllConnections();
    }
    const exit = await command;
    expect({ exit, output: JSON.parse(io.stdoutText) }).toMatchObject({
      exit: 5,
      output: {
        code: failure === "deadline expires" ? "API_TIMEOUT" : "API_UNREACHABLE",
        retryable: true,
      },
    });
    expect(io.stderrText).toBe("");
  },
);

it.each(["", "{}", '{"dashboard":true}', '{"workers":{}}', '{"workers":[null]}'])(
  "reports an invalid API response when worker list receives %j",
  async (body) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    try {
      const url = await listenOnRandomPort(server);
      await pointProfileAt(url);
      const io = createBufferIO();
      const exit = await runCli(["worker", "list", "--profile", "loopback", "--json"], io);
      const output = JSON.parse(io.stdoutText);
      expect({ exit, output }).toMatchObject({
        exit: 5,
        output: {
          code: "INVALID_API_RESPONSE",
          details: { httpStatus: 200, url },
          help: [expect.stringContaining(`${url}/api`)],
        },
      });
      expect(output).not.toHaveProperty("retryable");
      expect(io.stderrText).toBe("");
    } finally {
      await closeServer(server);
    }
  },
);
