import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { temporaryDirectory } from "../../test/support.ts";

const execute = promisify(execFile);

test("an invalid saved baseline exits with usage before Docker is called", async () => {
  const directory = await temporaryDirectory("perf-base-");
  const base = path.join(directory, "base.json");
  const calls = path.join(directory, "docker-calls");
  await writeFile(base, "{}");
  await writeFile(
    path.join(directory, "docker"),
    `#!/bin/sh\necho called >> '${calls}'\nexit 1\n`,
    { mode: 0o700 },
  );
  const result = await execute(
    process.execPath,
    ["--import", "tsx", "--conditions=swizzle-source", "scripts/perf.mts", "api", "--base", base],
    {
      env: {
        ...process.env,
        DOCKER_HOST: "unix:///unused.sock",
        PATH: `${directory}:${process.env.PATH}`,
      },
    },
  ).catch((error: { code: number; stdout: string; stderr: string }) => error);
  expect("code" in result ? result.code : 0).toBe(2);
  expect(result.stdout).toContain("cannot read the base result");
  expect(result.stdout).toContain("usage: just perf");
  expect(await readFile(calls, "utf8").catch(() => "no Docker calls")).toBe("no Docker calls");
});
