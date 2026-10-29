import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

import { mockDashboardApi, seededState } from "./dashboard-mock";

// The other flows run on the production build, which leaves out React's development diagnostics.
// This one serves the dashboard from Vite's dev server, as `just dev` does, where React reports
// misuse such as a hook a component calls only on some renders.

let server: ViteDevServer | undefined;
let cacheDir: string;

test.beforeAll(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "swizzle-e2e-vite-"));
  server = await createServer({
    cacheDir,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "silent",
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { port: 0, strictPort: false },
  });
  await server.listen();
});

test.afterAll(async () => {
  try {
    await server?.close();
  } finally {
    await rm(cacheDir, { force: true, recursive: true });
  }
});

test("moving between pages in the dev build logs no React diagnostic", async ({ page }) => {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      diagnostics.push(message.text());
  });
  await mockDashboardApi(page, seededState());
  await page.goto(server?.resolvedUrls?.local[0] ?? "");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Dashboard" });
  // Settings opens its first section.
  for (const [place, heading] of [
    ["Runs", "Runs"],
    ["Credentials", "Credentials"],
    ["Settings", "Agent access"],
  ] as const) {
    await nav.getByRole("link", { name: place }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
  await nav.getByRole("link", { name: /^Overview/u }).click();
  await page.getByRole("link", { name: "verify-probe" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "verify-probe" })).toBeVisible();

  expect(diagnostics).toEqual([]);
});
