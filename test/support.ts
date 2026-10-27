// Helpers every test file shares. A test owns its state: its directories come from
// temporaryDirectory() and are removed when it finishes, and it changes the environment and
// globals only through vi.stubEnv and vi.stubGlobal, which vitest.config.ts undoes before the next test.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { onTestFinished } from "vitest";

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
 * Polls until the predicate holds. The vitest test timeout is the hang tripwire, so a slow
 * machine waits longer instead of failing; pass the test's `signal` so the poll stops when
 * that timeout fires.
 */
export async function waitFor(
  signal: AbortSignal,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  while (!(await predicate())) {
    await delay(10, undefined, { signal });
  }
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
