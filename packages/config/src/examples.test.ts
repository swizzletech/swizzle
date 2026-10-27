import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseAutomationConfig } from "./schema.js";

// The shipped examples are what agents copy first, so each one must satisfy the live contract.
const examplesRoot = fileURLToPath(new URL("../../../infra/examples", import.meta.url));
const configPaths = (await readdir(examplesRoot, { recursive: true }))
  .filter((entry) => path.basename(entry) === "config.yaml")
  .sort();

describe("infra/examples", () => {
  it("contains example configs", () => {
    expect(configPaths.length).toBeGreaterThan(0);
  });

  it.each(configPaths)(
    "%s parses against the config schema and names an existing entrypoint",
    async (configPath) => {
      const directory = path.join(examplesRoot, path.dirname(configPath));
      const config = parseAutomationConfig(
        await readFile(path.join(examplesRoot, configPath), "utf8"),
      );

      await expect(access(path.join(directory, config.entrypoint))).resolves.toBeUndefined();
    },
  );
});
