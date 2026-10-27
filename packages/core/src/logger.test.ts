import path from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { temporaryDirectory } from "../../../test/support.js";
import { createLogger } from "./logger.js";

// Fastify logs each incoming request through the logger's `req` serializer.
function loggedUrl(url: string): unknown {
  const serializers: Record<string, (value: unknown) => { readonly url?: unknown }> = Reflect.get(
    createLogger("test"),
    pino.symbols.serializersSym,
  );
  return serializers.req?.({ headers: {}, method: "GET", url }).url;
}

describe("request logging", () => {
  it("keeps link tokens and OAuth credentials out of the logged URL", () => {
    expect(loggedUrl("/approvals/capability-token")).toBe("/approvals/[REDACTED]");
    expect(loggedUrl("/events/capability-token")).toBe("/events/[REDACTED]");
    expect(loggedUrl("/runs/run-1/events/gate")).toBe("/runs/run-1/events/gate");
    expect(loggedUrl("/oauth/callback/github?code=one-time-code&state=pending-state")).toBe(
      "/oauth/callback/github?code=[REDACTED]&state=[REDACTED]",
    );
    expect(loggedUrl("/runs?environment=staging")).toBe("/runs?environment=staging");
  });
});

describe("error logging", () => {
  // pino serializes only `err` by default; an Error under any other key logs its enumerable
  // properties alone, which hid a worker's DOCKER_CONTROL_TIMEOUT as `error: {}`.
  it("logs an error's message, code and cause under err and error", () => {
    const serializers: Record<string, (value: unknown) => Record<string, unknown>> = Reflect.get(
      createLogger("test"),
      pino.symbols.serializersSym,
    );
    const error = Object.assign(
      new Error("Docker did not answer.", { cause: new Error("connect ECONNREFUSED") }),
      { code: "DOCKER_CONTROL_TIMEOUT" },
    );
    for (const key of ["err", "error"]) {
      expect(serializers[key]?.(error)).toMatchObject({
        code: "DOCKER_CONTROL_TIMEOUT",
        message: "Docker did not answer.: connect ECONNREFUSED",
        type: "Error",
      });
    }
  });
});

describe("production logging", () => {
  // An async stdout buffer has no bound: when Docker's log pipe falls behind a request flood, the
  // buffered lines fill the heap and the API dies. A sync write waits for the pipe instead.
  it("writes stdout synchronously", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SWIZZLE_LOG_FILE", "");
    vi.resetModules();
    const { createLogger: createProductionLogger } = await import("./logger.js");
    const stream = Reflect.get(createProductionLogger("test"), pino.symbols.streamSym);
    expect(stream.sync).toBe(true);
  });

  // A worker thread writes the log file. An async transport queues on the main thread every line
  // the worker has not taken yet, so a request flood holds as much memory as it logs.
  it("holds no flood of lines in memory while it writes the log file", async () => {
    const directory = await temporaryDirectory("swizzle-log-");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SWIZZLE_LOG_FILE", path.join(directory, "api.log"));
    vi.stubEnv("LOG_LEVEL", "info");
    vi.resetModules();
    const { createLogger: createProductionLogger } = await import("./logger.js");
    const log = createProductionLogger("test");
    const url = `/hooks?environment=${"x".repeat(12 * 1024)}`;

    // thread-stream queues each line it cannot hand to the worker as a Buffer, so a backlog shows
    // in external memory, not in the V8 heap.
    const before = process.memoryUsage().external;
    // 24 MiB of request lines, logged without yielding the way a busy event loop does.
    for (let index = 0; index < 2_000; index += 1) {
      log.info({ req: { method: "POST", url } }, "incoming request");
    }
    const held = process.memoryUsage().external - before;

    const stream = Reflect.get(log, pino.symbols.streamSym);
    await new Promise((resolve) => {
      stream.once("close", resolve);
      stream.end();
    });
    expect(held).toBeLessThan(8 * 1024 * 1024);
  });
});
