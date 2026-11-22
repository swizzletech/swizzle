import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { temporaryDirectory } from "../test/support.js";
import { holdPorts } from "./dev-stack-ports.ts";

test("keeps distinct ports when two services recorded the same port and forwards to a bound service", async () => {
  const directory = await temporaryDirectory("swizzle-ports-");
  const backend = createServer((_request, response) => response.end("from the API"));
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const address = backend.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP port");

  const endpoints = await holdPorts(directory, {
    api: address.port,
    web: address.port,
    localWorker: 0,
  });
  try {
    expect(new Set(Object.values(endpoints.ports)).size).toBe(3);
    await writeFile(endpoints.targets.api, `${process.pid} ${address.port}\n`);

    const response = await fetch(`http://127.0.0.1:${endpoints.ports.api}`);

    expect(await response.text()).toBe("from the API");
  } finally {
    endpoints.close();
    backend.closeAllConnections();
    backend.close();
  }
});
