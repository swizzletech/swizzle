import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { temporaryDirectory } from "../../../test/support.js";
import { createLogger } from "./logger.js";

const run = promisify(execFile);

function runFileLogger(file: string, script: string, signal: AbortSignal, frequency = "daily") {
  return run(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import { createLogger } from ${JSON.stringify(new URL("./logger.ts", import.meta.url).href)};
        const log = createLogger("test");
        ${script}
      `,
    ],
    {
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        LOG_LEVEL: "info",
        NODE_ENV: "production",
        SWIZZLE_LOG_FILE: file,
        SWIZZLE_LOG_FILE_COUNT: "10",
        SWIZZLE_LOG_FILE_FREQUENCY: frequency,
        SWIZZLE_LOG_FILE_SIZE: "100M",
      },
      signal,
    },
  );
}

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
  it("keeps the caller alive when a log file stops accepting writes", async ({ signal }) => {
    const directory = await temporaryDirectory("swizzle-log-stalled-");
    const fifo = path.join(directory, "api.1.log");
    await run("mkfifo", [fifo], { signal });
    const reader = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    onTestFinished(() => reader.close());
    const child = runFileLogger(
      path.join(directory, "api.log"),
      `
        const before = process.memoryUsage().external;
        const payload = "x".repeat(12 * 1024);
        for (let index = 0; index < 2_000; index += 1) log.info({ payload }, "request");
        const held = process.memoryUsage().external - before;
        await new Promise(resolve => setImmediate(resolve));
        log.info("first request after the stall");
        await new Promise(resolve => setImmediate(resolve));
        log.info("second request after the stall");
        console.log("caller survived:" + held);
      `,
      signal,
    );
    child.child.stdout?.once("data", () => void reader.close());
    const { stdout, stderr } = await child;
    const lines = stdout.trim().split("\n");
    const [completed, held] = lines.pop()?.split(":") ?? [];
    expect(completed).toBe("caller survived");
    expect(Number(held)).toBeLessThan(8 * 1024 * 1024);
    expect(lines.slice(-2).map((line) => JSON.parse(line).msg)).toEqual([
      "first request after the stall",
      "second request after the stall",
    ]);
    expect(stderr).toBe(
      `Swizzle switched file logging to stdout after "${directory}/api.log" failed. Cause "_flushSync took too long (10s)"\n`,
    );
  });

  it("reports the file failure once and switches to stdout", async ({ signal }) => {
    const directory = await temporaryDirectory("swizzle-log-failed-");
    const { stdout, stderr } = await runFileLogger(
      path.join(directory, "api.log"),
      `
        await new Promise((resolve, reject) => {
          log.flush(error => error ? resolve() : reject(new Error("file flush unexpectedly succeeded")));
        });
        log.info("first request");
        await new Promise(resolve => setImmediate(resolve));
        const secondLogger = createLogger("second");
        secondLogger.info("second request");
        await new Promise(resolve => setImmediate(resolve));
        secondLogger.child({}).info("third request");
        await new Promise((resolve, reject) => {
          log.flush(error => error ? reject(error) : resolve());
        });
      `,
      signal,
      "invalid-frequency",
    );
    expect(stderr.trim().split("\n")).toEqual([
      expect.stringContaining(
        `Swizzle switched file logging to stdout after "${directory}/api.log" failed. Cause "invalid-frequency`,
      ),
    ]);
    expect(
      stdout
        .trim()
        .split("\n")
        .map((line) => {
          const { name, msg } = JSON.parse(line);
          return { name, msg };
        }),
    ).toEqual([
      { name: "test", msg: "first request" },
      { name: "second", msg: "second request" },
      { name: "second", msg: "third request" },
    ]);
  });

  it("writes stdout synchronously", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SWIZZLE_LOG_FILE", "");
    vi.resetModules();
    const { createLogger: createProductionLogger } = await import("./logger.js");
    const stream = Reflect.get(createProductionLogger("test"), pino.symbols.streamSym);
    expect(stream.sync).toBe(true);
  });

  it("holds no flood of lines in memory while it writes the log file", async ({ signal }) => {
    const directory = await temporaryDirectory("swizzle-log-");
    const { stdout, stderr } = await runFileLogger(
      path.join(directory, "api.log"),
      `
        const url = "/hooks?environment=" + "x".repeat(12 * 1024);
        const before = process.memoryUsage().external;
        for (let index = 0; index < 2_000; index += 1) {
          log.info({ req: { method: "POST", url } }, "incoming request");
        }
        process.stdout.write((process.memoryUsage().external - before) + "\\n", () => process.exit(0));
      `,
      signal,
    );
    expect(stderr).toBe("");
    expect(Number(stdout.trim())).toBeLessThan(8 * 1024 * 1024);
    const lines = (await readFile(path.join(directory, "api.1.log"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2_000);
    expect(JSON.parse(lines[1_999] ?? "")).toMatchObject({
      msg: "incoming request",
      req: { method: "POST" },
    });
  });
});
