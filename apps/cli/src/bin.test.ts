import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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
  it("answers before the command graph loads", { timeout: 30_000 }, async () => {
    expect(await swizzle("--version")).toEqual({ stdout: `${VERSION}\n`, stderr: "" });
    expect((await swizzle("list", "--help")).stderr).toContain("graph loaded");
  });
});
