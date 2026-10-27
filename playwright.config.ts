import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Each run owns its server port and output directory, so worktrees can run e2e at once.
// Vite preview binds the first free port from 4173 up and prints it; the wait pattern below stores
// it in SWIZZLE_E2E_PORT, and the workers, which evaluate this file again, read it.
// Named here, created by Playwright on first write, so loading the config leaves nothing behind.
process.env.SWIZZLE_E2E_OUTPUT_DIR ??= path.join(os.tmpdir(), `swizzle-e2e-${randomUUID()}`);
const port = process.env.SWIZZLE_E2E_PORT;

export default defineConfig({
  testDir: "./apps/web/tests",
  outputDir: process.env.SWIZZLE_E2E_OUTPUT_DIR,
  fullyParallel: true,
  // Four workers finish the suite in about 10 s, as fast as eight and faster than sixteen, which
  // spend more than twice the CPU on browsers a host shared with other gates must also run.
  workers: 4,
  // Budgets ten times the CPU a flow needs across its browser, the preview server and the worker,
  // so a loaded host that gives it a tenth of a core still passes it: a page that parses a
  // flowchart reaches its first assertion after up to 1.3 s of CPU, and the heaviest flow spends
  // about 4 s.
  expect: { timeout: 15_000 },
  timeout: 45_000,
  retries: 0,
  reporter: [["dot"], ["./scripts/e2e-run-reporter.ts"]],
  // The terminal shows dots, failures and the log path; every line the tests and the web
  // server print goes to the run reporter's e2e.log instead.
  quiet: true,
  use: {
    ...(port === undefined ? {} : { baseURL: `http://127.0.0.1:${port}` }),
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @swizzle/web exec vite preview --host 127.0.0.1",
    // Specs mock the API in the page; anything they miss hits a closed port, never a dev API.
    env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:1" },
    // The first loopback URL Vite prints is its Local line; a color code (ESC [ n m) may precede the port.
    wait: { stdout: /http:\/\/127\.0\.0\.1:(?:.\[[\d;]*m)?(?<swizzle_e2e_port>\d+)/ },
    // Piped, so e2e.log keeps the server's own output, such as dependency re-optimization.
    stdout: "pipe",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
