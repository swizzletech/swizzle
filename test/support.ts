// Helpers every test file shares. A test owns its state: its directories come from
// temporaryDirectory() and are removed when it finishes, and it changes the environment and
// globals only through vi.stubEnv and vi.stubGlobal, which vitest.config.ts undoes before the next test.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { onTestFinished, vi } from "vitest";

/** A 32-byte SWIZZLE_ENCRYPTION_KEY. */
export const TEST_ENCRYPTION_KEY = "12345678901234567890123456789012";

/** Every directory temporaryDirectory() made for this test file, kept after their removal. */
export const temporaryDirectories = new Set<string>();

/**
 * Creates a directory under the OS temp dir, removed when the calling test finishes. A process
 * that still names it then counts as the test's (test/processes.ts).
 */
export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  onTestFinished(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

/**
 * Polls until the predicate holds: the way a test waits on a state that announces no event, such
 * as a row another process writes. It has no budget of its own; the vitest test timeout is the hang
 * tripwire, so a slow machine waits longer instead of failing. Pass the test's `signal` so the poll
 * stops when that timeout fires.
 */
export async function waitFor(
  signal: AbortSignal,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  while (!(await predicate())) {
    // conventions-allow tests-wait-on-state: the one poll interval, between two reads of the state.
    await delay(10, undefined, { signal });
  }
}

/**
 * Holds every `AbortSignal.timeout(ms)` deadline of this length until the test expires it: the way
 * a test proves a deadline fires without waiting for it, and without a loaded runner firing it
 * before the stall it proves is in place. Deadlines of other lengths stay real. Without a length
 * it holds every deadline, so a test against a shared engine such as the host's Docker daemon
 * waits as long as its project's ceiling instead of failing on a deadline an idle host meets.
 * `expire(index)` ends the deadline the code made at that position; `expire()` ends every one,
 * also those made later; `expireNewest()` ends the one of the step the test stalls.
 */
export function heldDeadlines(ms?: number): {
  expire(index?: number): void;
  expireNewest(): void;
} {
  const held: AbortController[] = [];
  let expired = false;
  const end = (deadline: AbortController | undefined) =>
    deadline?.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  // conventions-allow tests-wait-on-state: the one real deadline, for the lengths the test does not hold.
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((length) => {
    if (ms !== undefined && length !== ms) return timeout(length);
    const deadline = new AbortController();
    held.push(deadline);
    if (expired) end(deadline);
    return deadline.signal;
  });
  return {
    expire(index) {
      if (index !== undefined) return end(held[index]);
      expired = true;
      for (const deadline of held) end(deadline);
    },
    expireNewest() {
      end(held.at(-1));
    },
  };
}

/**
 * An HTTP forward proxy that answers every request with an empty 200 and records it as
 * `<method> <absolute url>`, closed when the calling test finishes. Point a client's proxy at
 * `url` to prove its requests go through the proxy.
 */
export async function recordingProxy(): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
