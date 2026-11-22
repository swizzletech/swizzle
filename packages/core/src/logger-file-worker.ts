import { fork } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { FileSettings, Reply, Request } from "./logger-file-writer.js";

const STALL_TIMEOUT_MS = 5_000;

export default async function fileTransport(
  settings: FileSettings & { readonly stall: SharedArrayBuffer },
) {
  const entry = import.meta.url.endsWith(".ts")
    ? "./logger-file-writer.ts"
    : "./logger-file-writer.js";
  const writer = fork(fileURLToPath(new URL(entry, import.meta.url)), [], {
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let pending: ((error?: Error) => void) | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    pending?.(error);
  };
  writer.on("message", (reply: Reply) => {
    if (reply.kind === "error") fail(new Error(reply.message));
    else pending?.();
  });
  writer.on("error", fail);
  writer.once("disconnect", () => fail(new Error("File log writer exited")));

  const request = (message: Request) =>
    new Promise<void>((resolve, reject) => {
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      const timer = setTimeout(() => {
        Atomics.store(new Int32Array(settings.stall), 0, 1);
        writer.kill("SIGKILL");
        fail(new Error("File log sink stalled"));
      }, STALL_TIMEOUT_MS);
      pending = (error) => {
        clearTimeout(timer);
        pending = undefined;
        if (error === undefined) resolve();
        else reject(error);
      };
      writer.send(message, (error) => {
        if (error !== null) fail(error);
      });
    });
  try {
    const { stall: _stall, ...fileSettings } = settings;
    await request({ kind: "open", settings: fileSettings });
  } catch (error) {
    writer.kill("SIGKILL");
    throw error;
  }
  const stream = new Writable({
    decodeStrings: false,
    highWaterMark: 1,
    write(data: string, _encoding, done) {
      void request({ kind: "write", data }).then(() => done(), done);
    },
    final(done) {
      void request({ kind: "write", data: "" }).then(() => done(), done);
    },
    destroy(error, done) {
      if (error !== null) writer.kill("SIGKILL");
      else if (writer.connected) writer.disconnect();
      done(error);
    },
  });
  return Object.assign(stream, {
    flush(done: (error?: Error | null) => void) {
      stream.write("", done);
    },
  });
}
