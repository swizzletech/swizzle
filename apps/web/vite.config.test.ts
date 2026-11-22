import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { vi } from "vitest";

import { temporaryDirectory } from "../../test/support.js";

test("the dev server refuses to be framed", async () => {
  vi.stubEnv("WEB_DEV_PORT_FILE", undefined);
  const server = await devServer(await temporaryDirectory("swizzle-vite-cache-"));
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0] ?? "";
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");

    const revalidated = await fetch(url, {
      headers: { "if-none-match": response.headers.get("etag") ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("x-frame-options")).toBe("DENY");
    expect(revalidated.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  } finally {
    await server.close();
  }
});

test("the dev server publishes the port it actually bound", async () => {
  const directory = await temporaryDirectory("swizzle-vite-port-");
  const file = path.join(directory, "dashboard.port");
  vi.stubEnv("WEB_DEV_PORT_FILE", file);
  const server = await devServer(directory);
  try {
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await server.listen();
    const url = new URL(server.resolvedUrls?.local[0] ?? "");
    expect(await readFile(file, "utf8")).toBe(`${process.pid} ${url.port}\n`);
  } finally {
    await server.close();
  }
});

function devServer(cacheDir: string) {
  return createServer({
    cacheDir,
    configFile: fileURLToPath(new URL("vite.config.ts", import.meta.url)),
    logLevel: "silent",
    root: fileURLToPath(new URL(".", import.meta.url)),
    server: { port: 0, strictPort: false },
  });
}
