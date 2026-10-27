import { once } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { OutputPump } from "./output-pump.js";

it("serializes both pipes, delivers the accepted UTF-8 prefix, and reports the first overflow", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events: string[] = [];
  let activeCallbacks = 0;
  const callback = (name: string) => async (chunk: string) => {
    expect(activeCallbacks).toBe(0);
    activeCallbacks++;
    await Promise.resolve();
    events.push(`${name}:${chunk}`);
    activeCallbacks--;
  };
  const output = new OutputPump({
    stdout,
    stderr,
    stdoutLimitBytes: 4,
    stderrLimitBytes: 4,
    onStdoutChunk: callback("out"),
    onStderrChunk: callback("err"),
    limitPolicy: "stop",
    onStop: (reason) => events.push(JSON.stringify(reason)),
  });
  const ended = Promise.all([once(stdout, "end"), once(stderr, "end")]);
  stdout.end("abcé");
  stderr.end("log");
  await ended;
  await output.finished();
  expect(events).toEqual(['{"kind":"limit","stream":"stdout"}', "out:abc", "err:log"]);
  expect([output.stdout, output.stderr, output.exceeded]).toEqual(["abc", "log", "stdout"]);
});

it("bounds Docker capture while delivering every text and binary byte", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const bytes: number[] = [];
  const logs: string[] = [];
  const output = new OutputPump({
    stdout,
    stderr,
    stdoutLimitBytes: 2,
    stderrLimitBytes: 2,
    onStdoutBytes: (chunk) => {
      bytes.push(...chunk);
    },
    onStderrChunk: (chunk) => {
      logs.push(chunk);
    },
    limitPolicy: "capture",
    onStop: () => {
      throw new Error("unexpected stop");
    },
  });
  const ended = Promise.all([once(stdout, "end"), once(stderr, "end")]);
  stdout.end(Buffer.from([0, 255, 128, 10]));
  stderr.end("complete log");
  await ended;
  await output.finished();
  expect(bytes).toEqual([0, 255, 128, 10]);
  expect(logs).toEqual(["complete log"]);
  expect([output.stdout, output.stderr]).toEqual(["", "co"]);
});

it("propagates a callback failure and skips callbacks already queued on the other pipe", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events: string[] = [];
  const failure = new Error("persistence failed");
  const output = new OutputPump({
    stdout,
    stderr,
    stdoutLimitBytes: 100,
    stderrLimitBytes: 100,
    onStdoutChunk: async () => {
      throw failure;
    },
    onStderrChunk: () => {
      events.push("delivered stderr");
    },
    limitPolicy: "stop",
    onStop: (reason) => events.push(reason.kind),
  });
  const ended = Promise.all([once(stdout, "end"), once(stderr, "end")]);
  stdout.end("result");
  stderr.end("log");
  await ended;
  await expect(output.finished()).rejects.toBe(failure);
  expect(events).toEqual(["callback-failed"]);
});
