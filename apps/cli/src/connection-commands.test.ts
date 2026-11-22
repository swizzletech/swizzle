import { spawn } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import { runCli } from "./main.js";
import { saveProfileConfig } from "./profile.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

beforeEach(async () => {
  vi.stubEnv("SWIZZLE_CONFIG_HOME", await temporaryDirectory("swizzle-browser-config-"));
  vi.stubEnv("SWIZZLE_PROFILE", "browser");
  await saveProfileConfig({
    profiles: { browser: { name: "browser", url: "http://127.0.0.1:1" } },
  });
});

async function authorizeAndOpen(authorizationUrl: string) {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      authorizationUrl,
      expiresAt: "2027-01-23T00:00:00Z",
      redirectUri: "https://example.com/oauth/callback/google",
      connection: {
        name: "example",
        project: { slug: "default" },
        provider: "google",
        environment: "staging",
        status: "pending",
        authorizationPending: true,
        lastErrorCode: null,
      },
    }),
  );
  const stderr: string[] = [];

  const exit = await runCli(
    [
      "connections",
      "authorize",
      "example",
      "--open",
      "--json",
      "--environment",
      "staging",
      "--api-url",
      "http://127.0.0.1:1",
    ],
    { stdout: () => undefined, stderr: (chunk) => stderr.push(chunk) },
  );

  return { exit, stderr: stderr.join("") };
}

it("keeps a non-web authorization URL out of the browser launcher", async () => {
  expect(await authorizeAndOpen("file:///tmp/oauth-instructions.html")).toEqual({
    exit: 0,
    stderr: "Could not open a browser; open the URL yourself.\n",
  });
  expect(spawn).not.toHaveBeenCalled();
});

it("passes a Windows authorization URL separately from the launcher command", async () => {
  vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
  const url = "https://example.com/oauth?client_id=client&scope=openid";
  expect(await authorizeAndOpen(url)).toEqual({ exit: 0, stderr: "" });
  const launches = vi.mocked(spawn).mock.calls.map(([program, args, options]) => ({
    args,
    program,
    url: options?.env?.SWIZZLE_BROWSER_URL,
  }));
  expect(launches).toEqual([
    {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -FilePath $env:SWIZZLE_BROWSER_URL",
      ],
      program: "powershell.exe",
      url,
    },
  ]);
});
