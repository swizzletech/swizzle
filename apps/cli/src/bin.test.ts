import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { temporaryDirectory } from "../../../test/support.js";
import { VERSION } from "./version.js";

const run = promisify(execFile);
const bin = fileURLToPath(new URL("./bin.ts", import.meta.url));
const reportGraph =
  'data:text/javascript,import{registerHooks}from"node:module";registerHooks({load(url,context,next){if(url.endsWith("/src/main.ts"))process.stderr.write("graph loaded\\n");return next(url,context)}})';
const swizzle = (...args: string[]) =>
  run(process.execPath, [
    ...["--conditions=swizzle-source", "--import", "tsx", "--import", reportGraph],
    ...[bin, ...args],
  ]);

describe("swizzle --version", () => {
  it("answers before the command graph loads", async () => {
    expect(await swizzle("--version")).toEqual({ stdout: `${VERSION}\n`, stderr: "" });
    expect((await swizzle("list", "--help")).stderr).toContain("graph loaded");
  });
});

it("identifies a recovered automation with a legacy binary rule on the home screen", async ({
  signal,
}) => {
  const cwd = await temporaryDirectory("swizzle-recovered-legacy-");
  await writeFile(
    path.join(cwd, "config.yaml"),
    `name: recovered-legacy
version: 1.0.0
entrypoint: main.js
trigger: { type: webhook, path: /hooks/recovered-legacy }
runtime:
  requirements:
    binaries: [{ name: node, version: v25.03.0 }]
`,
  );
  const configHome = await temporaryDirectory("swizzle-recovered-legacy-profile-");
  const { stdout } = await run(
    process.execPath,
    [
      "--conditions=swizzle-source",
      "--import",
      import.meta.resolve("tsx"),
      bin,
      "--profile",
      "missing",
      "--json",
    ],
    { cwd, env: { ...process.env, SWIZZLE_CONFIG_HOME: configHome }, signal },
  );

  expect(JSON.parse(stdout).folder).toEqual({ automation: "recovered-legacy" });
});

describe("swizzle logs --full", () => {
  it("prints real stderr lines through a pipe and preserves the string in JSON", async ({
    signal,
  }) => {
    const stderr = "first line\nsecond line\nthird line\n";
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.split("?")[0] !== "/runs/0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41") {
        response.writeHead(404).end(JSON.stringify({ error: "NOT_FOUND" }));
        return;
      }
      response.end(
        JSON.stringify({
          runId: "0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41",
          automationName: "log-probe",
          automationSlug: "log-probe",
          environment: "staging",
          status: "failed",
          state: "failed",
          placement: null,
          attemptsMade: 1,
          attemptsMax: 1,
          executions: [],
          stdout: '{"ok":false}',
          stderr,
          errorCode: null,
          errorMessage: null,
        }),
      );
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening", { signal });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No API port");
      const configHome = await temporaryDirectory("swizzle-cli-log-output-");
      await writeFile(
        path.join(configHome, "config.toml"),
        [
          'default_profile = "logs"',
          "[profile.logs]",
          `url = "http://127.0.0.1:${address.port}"`,
          'env = "staging"',
          'token = "fixture-token"',
        ].join("\n"),
      );
      const args = [
        "--conditions=swizzle-source",
        "--import",
        "tsx",
        bin,
        "logs",
        "--run",
        "0193b1d2-7f0c-7e55-9d5a-3c1f0b2a9e41",
        "--full",
      ];
      const options = {
        env: { ...process.env, SWIZZLE_CONFIG_HOME: configHome, SWIZZLE_PROFILE: "" },
        signal,
      };
      const json = await run(process.execPath, [...args, "--json"], options).catch((error) => {
        throw new Error(error.stdout, { cause: error });
      });
      expect(JSON.parse(json.stdout).stderr).toBe("first line\nsecond line\nthird line\n");
      expect(json.stderr).toBe("");
      const plain = await run(process.execPath, args, options);
      expect(plain.stdout).toContain("first line\nsecond line\nthird line\n");
      expect(plain.stderr).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("a profile aimed at the dashboard", () => {
  it("reports an actionable API URL error for read commands", async ({ signal }) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><html><body>Swizzle</body></html>");
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening", { signal });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No dashboard port");
      const url = `http://127.0.0.1:${address.port}`;
      const configHome = await temporaryDirectory("swizzle-cli-dashboard-url-");
      await writeFile(
        path.join(configHome, "config.toml"),
        [
          'default_profile = "dashboard"',
          "[profile.dashboard]",
          `url = "${url}"`,
          'env = "staging"',
          'token = "fixture-token"',
        ].join("\n"),
      );
      for (const command of [
        ["notify", "list"],
        ["secret", "list"],
        ["projects", "list"],
      ]) {
        const result = await run(
          process.execPath,
          ["--conditions=swizzle-source", "--import", "tsx", bin, ...command, "--json"],
          { env: { ...process.env, SWIZZLE_CONFIG_HOME: configHome, SWIZZLE_PROFILE: "" }, signal },
        ).then(
          (output) => ({ ...output, code: 0 }),
          (error) => ({
            stdout: String(error.stdout),
            stderr: String(error.stderr),
            code: error.code,
          }),
        );
        expect(result.code).not.toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain("UNEXPECTED_CLI_ERROR");
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({ code: "INVALID_API_RESPONSE" });
        expect(result.stdout).toContain(url);
        expect(result.stdout).toContain("does not answer as a Swizzle API");
        expect(result.stdout).toContain(`${url}/api`);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("swizzle worker enroll", () => {
  it("suggests the API base URL when given the dashboard root", async ({ signal }) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><html><body>Swizzle</body></html>");
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening", { signal });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No dashboard port");
      const url = `http://127.0.0.1:${address.port}`;
      const configHome = await temporaryDirectory("swizzle-cli-worker-enroll-");
      const enrollment = run(
        process.execPath,
        [
          "--conditions=swizzle-source",
          "--import",
          "tsx",
          bin,
          "worker",
          "enroll",
          "--api-url",
          url,
          "--credential-file",
          path.join(configHome, "worker.env"),
          "--json",
        ],
        { env: { ...process.env, SWIZZLE_CONFIG_HOME: configHome, SWIZZLE_PROFILE: "" }, signal },
      );
      enrollment.child.stdin?.end("fixture-code");
      const result = await enrollment.then(
        (output) => ({ ...output, code: 0 }),
        (error) => ({
          stdout: String(error.stdout),
          stderr: String(error.stderr),
          code: error.code,
        }),
      );
      expect(result.code).toBe(5);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "INVALID_API_RESPONSE",
        error: `${url} does not answer as a Swizzle API. Expected a JSON response.`,
        help: [expect.stringContaining(`The dashboard serves the API at ${url}/api.`)],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
