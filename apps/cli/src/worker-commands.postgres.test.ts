import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { parseEnv } from "node:util";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import { createBufferIO, useCliTestEnvironment, withoutProfile } from "../test/cli-harness.js";
import { saveProfileConfig } from "./profile.js";

useCliTestEnvironment();

it.each([
  { args: [], expectedUrl: "http://api.localhost:19826" },
  { args: ["--profile", "worker-host"], expectedUrl: "https://worker-host.example.test" },
  {
    args: ["--profile", "worker-host", "--api-url", "https://override.example.test"],
    expectedUrl: "https://override.example.test",
  },
])("enrolls at $expectedUrl and writes only private credentials", async ({ args, expectedUrl }) => {
  await withoutProfile();
  if (args.includes("--profile")) {
    await saveProfileConfig({
      profiles: { "worker-host": { name: "worker-host", url: "https://worker-host.example.test" } },
    });
  }
  vi.stubEnv("SWIZZLE_API_URL", undefined);
  vi.resetModules();
  const { runCli } = await import("./main.js");
  const directory = await temporaryDirectory("swizzle-worker-enroll-");
  const file = path.join(directory, "credentials.json");
  const stdin = Readable.from(["one-use-code\n"]);
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get: (target, key, receiver) =>
        key === "stdin" ? stdin : Reflect.get(target, key, receiver),
    }),
  );
  const fetch = vi.fn(async () =>
    Response.json({
      worker: { id: "worker-1", name: "Laptop", tokenExpiresAt: "2027-01-23T00:00:00Z" },
      token: "worker-credential",
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const io = createBufferIO();
  expect(await runCli(["worker", "enroll", "--credential-file", file, "--json", ...args], io)).toBe(
    0,
  );
  expect(fetch).toHaveBeenCalledWith(
    `${expectedUrl}/worker/enroll`,
    expect.objectContaining({
      method: "POST",
      body: '{"code":"one-use-code"}',
    }),
  );
  expect(parseEnv(await readFile(file, "utf8"))).toEqual({
    SWIZZLE_WORKER_API_URL: expectedUrl,
    SWIZZLE_WORKER_ID: "worker-1",
    SWIZZLE_WORKER_TOKEN: "worker-credential",
    SWIZZLE_LOCAL_LLM_CONTROL_TOKEN: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    SWIZZLE_WORKER_TOKEN_EXPIRES_AT: "2027-01-23T00:00:00Z",
  });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(io.stdoutText)).toEqual({
    worker: { id: "worker-1", name: "Laptop", state: "enrolled" },
    credentialFile: file,
  });
  expect(io.stdoutText).not.toContain("worker-credential");
});

it.each(["http://worker.example.test", "http://localhost.example.test", "http://192.0.2.1"])(
  "refuses unencrypted enrollment at %s",
  async (apiUrl) => {
    const { runCli } = await import("./main.js");
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-worker-tls-");
    expect(
      await runCli(
        [
          "worker",
          "enroll",
          "--api-url",
          apiUrl,
          "--credential-file",
          path.join(directory, "credentials.json"),
          "--json",
        ],
        io,
      ),
    ).toBe(2);
    expect(JSON.parse(io.stdoutText).code).toBe("WORKER_TLS_REQUIRED");
  },
);

it("prints the API's disk warning for a worker whose active run images pass its budget", async () => {
  const { runCli } = await import("./main.js");
  const worker = {
    id: "worker-1",
    name: "gpu-home",
    state: "online",
    draining: false,
    services: [],
    localLlm: null,
    profiles: ["gpu"],
    capacity: 2,
    slotsInUse: 0,
    currentRuns: [],
    runImageDisk: {
      activeBytes: 3 * 1024 * 1_048_576,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 1024 * 1_048_576,
    },
    runImageDiskOverBudget: {
      activeBytes: 3 * 1024 * 1_048_576,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 1024 * 1_048_576,
    },
    runImageDiskWarning: { title: "gpu-home keeps 3.0 GiB.", todo: "Remove deployments." },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ workers: [worker] })),
  );
  const io = createBufferIO();

  expect(await runCli(["worker", "list", "--json", "--api-url", "http://127.0.0.1:1"], io)).toBe(0);
  expect(JSON.parse(io.stdoutText)).toMatchObject({
    workers: [{ id: "worker-1", name: "gpu-home", state: "online", groups: "gpu" }],
    warnings: ["gpu-home keeps 3.0 GiB. Remove deployments."],
  });
});
