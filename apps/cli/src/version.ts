// A leaf module of node builtins only: `bin.ts` answers `--version` from it before the command
// graph loads. package.json sits one level above both src/ and dist/.
import { readFileSync } from "node:fs";

export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    readonly version: string;
  }
).version;
