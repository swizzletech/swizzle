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
// A load hook that reports on stderr when main.ts, the root of the command graph, loads.
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
