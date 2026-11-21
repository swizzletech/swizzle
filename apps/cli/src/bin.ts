#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "./version.js";

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { runNodeCli } = await import("./main.js");
  await runNodeCli();
}
