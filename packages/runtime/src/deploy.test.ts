import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import { deployAutomation } from "./index.js";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

describe("deployAutomation", () => {
  it("stores the source under name/version/deployment and records it in the manifest", async () => {
    const artifactsDirectory = await temporaryDirectory("swizzle-artifacts-");
    const files = ["README.md", "config.yaml", "flow.mermaid", "main.py", "sample-payload.json"];

    const deployment = await deployAutomation({
      artifactsDirectory,
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "deployment-test",
    });

    const locator = { relativeRootPath: "hello-webhook/1.0.0/deployment-test", type: "local" };
    expect(deployment.artifactLocator).toMatchObject(locator);
    expect(path.relative(artifactsDirectory, deployment.artifactRootPath)).toBe(
      path.join("hello-webhook", "1.0.0", "deployment-test"),
    );
    expect(await readFile(path.join(deployment.sourceDirectory, "main.py"), "utf8")).toBe(
      await readFile(path.join(repoRoot, "infra/examples/hello-webhook/main.py"), "utf8"),
    );
    const manifest = JSON.parse(await readFile(deployment.manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      artifactLocator: locator,
      deploymentId: "deployment-test",
      sourceHash: deployment.sourceHash,
    });
    expect([...manifest.files].sort()).toEqual(files);
  });
});
