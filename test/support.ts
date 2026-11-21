import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { onTestFinished, vi } from "vitest";

export const TEST_ENCRYPTION_KEY = "12345678901234567890123456789012";

export const temporaryDirectories = new Set<string>();

export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  onTestFinished(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

export async function waitFor(
  signal: AbortSignal,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  while (!(await predicate())) {
    // conventions-allow tests-wait-on-state: the one poll interval, between two reads of the state.
    await delay(10, undefined, { signal });
  }
}

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
