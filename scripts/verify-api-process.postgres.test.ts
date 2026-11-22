import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { TEST_ENCRYPTION_KEY, temporaryDirectory, waitFor } from "../test/support.js";
import { startVerificationApi } from "./verify-api-process.js";

it("publishes the actual public and private API ports", async ({ signal }) => {
  const directory = await temporaryDirectory("swizzle-api-ports-");
  const publicFile = path.join(directory, "public.port");
  const privateFile = path.join(directory, "private.port");
  const api = await startVerificationApi({
    ...process.env,
    API_PORT: "0",
    LOG_LEVEL: "info",
    SWIZZLE_ARTIFACTS_DIR: directory,
    SWIZZLE_DEV_API_PORT_FILE: publicFile,
    SWIZZLE_DEV_LOCAL_WORKER_PORT_FILE: privateFile,
    SWIZZLE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    SWIZZLE_LOCAL_WORKER_TOKEN: `swz_${randomBytes(32).toString("base64url")}`,
  });
  try {
    const published = () =>
      Promise.all([readFile(publicFile, "utf8"), readFile(privateFile, "utf8")]);
    await waitFor(signal, () =>
      published().then(
        () => true,
        () => false,
      ),
    );
    const [publicPort, privatePort] = await published();
    const pid = publicPort.split(" ")[0];
    expect(pid).toMatch(/^[1-9]\d*$/u);
    expect(() => process.kill(Number(pid), 0)).not.toThrow();
    expect(publicPort).toBe(`${pid} ${new URL(api.url).port}\n`);
    expect(privatePort).toBe(`${pid} ${new URL(api.localUrl ?? "").port}\n`);
  } finally {
    await api.close();
  }
});
