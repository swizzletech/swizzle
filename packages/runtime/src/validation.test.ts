import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadAutomationDefinition } from "./index.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = path.resolve(sourceRoot, "..");
const fixturesRoot = path.join(packageRoot, "test-fixtures");

describe("loadAutomationDefinition", () => {
  it("rejects automation folders without config.yaml", async () => {
    await expect(
      loadAutomationDefinition(path.join(fixturesRoot, "does-not-exist")),
    ).rejects.toMatchObject({
      code: "AUTOMATION_CONFIG_NOT_FOUND",
    });
  });

  it("rejects missing entrypoint files", async () => {
    await expect(
      loadAutomationDefinition(path.join(fixturesRoot, "missing-entrypoint")),
    ).rejects.toMatchObject({
      code: "AUTOMATION_ENTRYPOINT_NOT_FOUND",
    });
  });

  it("rejects unsupported entrypoint extensions", async () => {
    await expect(
      loadAutomationDefinition(path.join(fixturesRoot, "unsupported-entrypoint")),
    ).rejects.toMatchObject({
      code: "AUTOMATION_ENTRYPOINT_UNSUPPORTED",
    });
  });
});
