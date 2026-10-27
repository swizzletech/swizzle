#!/usr/bin/env node
// The `swizzle` executable. A bare `-v`, `-V` or `--version` answers before the command graph
// loads; everything else goes to `runCli` in main.ts.
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "./version.js";

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { runNodeCli } = await import("./main.js");
  await runNodeCli();
}
