import path from "node:path";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";
import { packageRoot } from "../test/platform-harness.js";

describe("deployment credentials", () => {
  it("injects the secret a deployment bound, not a later one of the same name", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-platform-"), "artifacts"),
    });
    const place = { environment: "local", projectId: DEFAULT_PROJECT_ID };
    const automationDirectory = path.join(packageRoot, "test-fixtures/platform-env-snapshot");
    const trigger = () =>
      platform.startManualRun({
        automationName: "platform-env-snapshot",
        environment: "local",
      });
    const first = await platform.upsertSecret("DECLARED_SECRET", "first", place);
    await platform.deployAutomationToPlatform({ automationDirectory, environment: "local" });

    // A new value under the old name is a new secret, which nobody approved for this version.
    await platform.deleteSecret(first.id);
    await platform.upsertSecret("DECLARED_SECRET", "second", place);
    await expect(trigger()).rejects.toMatchObject({
      code: "PLATFORM_REQUIRED_SECRETS_MISSING",
      details: { missingSecrets: ["DECLARED_SECRET"] },
    });

    // Deploying the same version again binds it, though source and config did not change.
    expect(
      await platform.checkDeployment({ automationDirectory, environment: "local" }),
    ).toMatchObject({ action: "update", changes: [] });
    const redeployed = await platform.deployAutomationToPlatform({
      automationDirectory,
      environment: "local",
    });
    expect(redeployed).toMatchObject({ action: "update", seq: 2 });
    expect(
      await platform.checkDeployment({ automationDirectory, environment: "local" }),
    ).toMatchObject({ action: "noop", changes: [] });
    await trigger();
    const run = await platform.processNextPlatformRun({
      environment: { PATH: process.env.PATH, SWIZZLE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
    });
    expect(run?.executions[0]?.secretUsages).toEqual([
      expect.objectContaining({ secretName: "DECLARED_SECRET", secretVersion: 1 }),
    ]);
    expect(run?.status).toBe("succeeded");
  });

  it("refuses a deploy whose use was revoked while it built", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const platform = await testPlatform({
      artifactsDirectory: path.join(await temporaryDirectory("swizzle-platform-"), "artifacts"),
    });
    await platform.upsertSecret("DECLARED_SECRET", "value", {
      environment: "local",
      projectId: DEFAULT_PROJECT_ID,
    });
    // The deployer may use the secret when the deploy starts; the right is gone right after.
    let mayUse = true;
    const deploy = platform.deployAutomationToPlatform({
      automationDirectory: path.join(packageRoot, "test-fixtures/platform-env-snapshot"),
      credentials: async () => {
        if (!mayUse) throw new Error("use revoked");
        mayUse = false;
      },
      environment: "local",
    });

    await expect(deploy).rejects.toThrow("use revoked");
    expect(await platform.store.getActiveDeploymentBySlug("platform-env-snapshot", "local")).toBe(
      null,
    );
  });
});
