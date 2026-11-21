import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { temporaryDirectory } from "../../test/support.js";

test("the dev server refuses to be framed", async () => {
  const server = await createServer({
    cacheDir: await temporaryDirectory("swizzle-vite-cache-"),
    configFile: fileURLToPath(new URL("vite.config.ts", import.meta.url)),
    logLevel: "silent",
    root: fileURLToPath(new URL(".", import.meta.url)),
    server: { port: 0, strictPort: false },
  });
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
