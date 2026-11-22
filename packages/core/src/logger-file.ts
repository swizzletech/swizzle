import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pino from "pino";
import ThreadStream from "thread-stream";
import type fileTransport from "./logger-file-worker.js";

interface FileThreadStream extends ThreadStream {
  readonly writableErrored: Error | null;
  unref(): void;
}

const sinks = new Map<string, ReturnType<typeof openFileLogSink>>();

export function createStdoutLogSink(): ReturnType<typeof pino.destination> {
  return pino.destination({ dest: 1, sync: true });
}

export function fileLogSink(file: string) {
  const existing = sinks.get(file);
  if (existing !== undefined) return existing;
  const sink = openFileLogSink(file);
  sinks.set(file, sink);
  return sink;
}

function openFileLogSink(file: string) {
  const stall = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const source = import.meta.url.endsWith(".ts")
    ? "./logger-file-worker.ts"
    : "./logger-file-worker.js";
  const settings = {
    file,
    frequency: process.env.SWIZZLE_LOG_FILE_FREQUENCY ?? "daily",
    limit: { count: Number(process.env.SWIZZLE_LOG_FILE_COUNT ?? 10) },
    size: process.env.SWIZZLE_LOG_FILE_SIZE ?? "20M",
    stall,
  } satisfies Parameters<typeof fileTransport>[0];
  const stream = new ThreadStream({
    filename: fileURLToPath(new URL(source, import.meta.url)),
    sync: true,
    workerData: settings,
    workerOpts: { execArgv: [] },
  }) as FileThreadStream;
  let stdout: ReturnType<typeof createStdoutLogSink> | undefined;

  function fail(error = stream.writableErrored ?? new Error("File log worker exited")) {
    if (stdout !== undefined) return stdout;
    stdout = createStdoutLogSink();
    const cause = Atomics.load(new Int32Array(stall), 0) ? "File log sink stalled" : error.message;
    try {
      writeSync(
        2,
        `Swizzle switched file logging to stdout after ${JSON.stringify(file)} failed. Cause ${JSON.stringify(cause)}\n`,
      );
    } catch {
      return stdout;
    }
    return stdout;
  }

  function finish() {
    if (stdout !== undefined) return;
    stream.end();
    if (stream.writableErrored !== null) fail(stream.writableErrored);
  }

  stream.once("ready", () => stream.unref());
  stream.on("error", fail);
  stream.once("close", () => fail());
  process.once("exit", finish);

  return {
    flush(callback: (error?: Error) => void) {
      if (stdout !== undefined) {
        stdout.flush(callback);
        return;
      }
      stream.flush((error) => {
        if (error !== undefined) fail(stream.writableErrored ?? error);
        callback(error);
      });
    },
    write(line: string) {
      if (stdout === undefined && stream.write(line)) return;
      (stdout ?? fail()).write(line);
    },
  };
}
