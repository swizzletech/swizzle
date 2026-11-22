import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { type ExecutionOutcome, executeProcess } from "./process-execution.js";

const termination = {
  kind: "host",
  signals: { graceful: "SIGTERM", force: "SIGKILL", abortGraceMs: 100 },
  exitGraceMs: 100,
} as const;

it.for(["exit", "timeout", "aborted"] as const)(
  "settles a stalled output callback after %s",
  async (stop) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let markDelivered = () => {};
    const delivered = new Promise<void>((resolve) => {
      markDelivered = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abort = new AbortController();
    const child = spawn(process.execPath, [
      "-e",
      stop === "exit"
        ? "console.log('{}')"
        : "console.log('{}'); process.stdin.resume(); setInterval(() => {}, 1000)",
    ]);
    const closed = once(child, "close");
    let outcome: ExecutionOutcome | undefined;
    const execution = executeProcess({
      abortSignal: abort.signal,
      start: () => child,
      startError: (error) => error,
      sendInput: (stdin) => stdin.end(),
      termination,
      onStdoutChunk: () => {
        markDelivered();
        return released;
      },
      outputLimitBytes: 1024,
      timeoutMs: 10_000,
    }).then((result) => {
      outcome = result;
    });
    try {
      await delivered;
      if (stop === "aborted") abort.abort();
      if (stop === "timeout") await vi.advanceTimersByTimeAsync(10_000);
      await closed;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toMatchObject({
        stoppedBy: stop === "exit" ? "callback-failed" : stop,
        stdout: "{}\n",
      });
    } finally {
      release();
      await execution;
      vi.useRealTimers();
    }
  },
);

it("reports cancellation when the user aborts during a timeout stop", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const abort = new AbortController();
  const child = spawn(process.execPath, ["-e", "console.log('{}'); setInterval(() => {}, 1000)"]);
  const ready = once(child.stdout, "data");
  const execution = executeProcess({
    abortSignal: abort.signal,
    start: () => child,
    startError: (error) => error,
    sendInput: (stdin) => stdin.end(),
    termination,
    outputLimitBytes: 1024,
    timeoutMs: 10_000,
  });
  try {
    await ready;
    vi.advanceTimersByTime(10_000);
    abort.abort();
    expect(await execution).toMatchObject({ stoppedBy: "aborted" });
  } finally {
    child.kill("SIGKILL");
    await execution;
    vi.useRealTimers();
  }
});

it("finishes slow post-exit output delivery while callbacks keep completing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const child = spawn(process.execPath, ["-e", "console.log('{}'); console.error('log')"]);
  const exited = once(child, "exit");
  let markSecondDelivery = () => {};
  const secondDelivery = new Promise<void>((resolve) => {
    markSecondDelivery = resolve;
  });
  let releaseFirst = () => {};
  let releaseSecond = () => {};
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondReleased = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const delivered: string[] = [];
  const onChunk = async (chunk: string) => {
    if (delivered.length === 0) {
      await firstReleased;
    } else {
      markSecondDelivery();
      await secondReleased;
    }
    delivered.push(chunk);
  };
  const execution = executeProcess({
    start: () => child,
    startError: (error) => error,
    sendInput: (stdin) => stdin.end(),
    termination,
    onStdoutChunk: onChunk,
    onStderrChunk: onChunk,
    outputLimitBytes: 1024,
    timeoutMs: 10_000,
  });
  try {
    await exited;
    await vi.advanceTimersByTimeAsync(3_000);
    releaseFirst();
    await secondDelivery;
    await vi.advanceTimersByTimeAsync(3_000);
    releaseSecond();
    expect(await execution).toMatchObject({
      exitCode: 0,
      stoppedBy: null,
      stdout: "{}\n",
      stderr: "log\n",
    });
    expect(delivered.sort()).toEqual(["log\n", "{}\n"]);
  } finally {
    releaseFirst();
    releaseSecond();
    await execution;
    vi.useRealTimers();
  }
});
