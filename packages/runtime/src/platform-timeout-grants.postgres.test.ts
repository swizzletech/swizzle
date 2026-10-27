import path from "node:path";

import { auditScope } from "@swizzle/db";

import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { temporaryDirectory } from "../../../test/support.js";

import { packageRoot, repoRoot } from "../test/platform-harness.js";

describe("platform timeout grants", () => {
  it("manages a per-automation timeout grant and cascades it on automation delete", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "8998d604-bd84-5fa5-af25-017f627311a4",
    });

    expect(
      await platform.getAutomationTimeoutGrant({
        environment: "local",
        automationName: "hello-webhook",
      }),
    ).toBeNull();

    const grant = await platform.setAutomationTimeoutGrant({
      environment: "local",
      automationName: "hello-webhook",
      maxTimeoutMs: 10_800_000,
      note: "long batch",
    });
    expect(grant).toMatchObject({
      automationSlug: "hello-webhook",
      environment: "local",
      maxTimeoutMs: 10_800_000,
      note: "long batch",
    });

    expect(
      await platform.getAutomationTimeoutGrant({
        environment: "local",
        automationName: "hello-webhook",
      }),
    ).toMatchObject({ maxTimeoutMs: 10_800_000 });
    const list = await platform.listAutomationTimeoutGrants("local");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ automationSlug: "hello-webhook", maxTimeoutMs: 10_800_000 });

    // Updating in place keeps a single row.
    const updated = await platform.setAutomationTimeoutGrant({
      environment: "local",
      automationName: "hello-webhook",
      maxTimeoutMs: 7_200_000,
    });
    expect(updated.maxTimeoutMs).toBe(7_200_000);
    expect(await platform.listAutomationTimeoutGrants("local")).toHaveLength(1);

    await platform.pauseAutomationTrigger("hello-webhook", "local");
    await platform.deleteAutomation({ environment: "local", automationName: "hello-webhook" });
    expect(await platform.listAutomationTimeoutGrants("local")).toEqual([]);
  });

  it("keeps timeout grants and their previous values when auditing fails", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-grant-audit-");
    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const deployment = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
    });
    const key = { automationName: "hello-webhook", environment: "local" };
    const set = (maxTimeoutMs: number) =>
      platform.setAutomationTimeoutGrant({ ...key, maxTimeoutMs });
    const missingAudit = <T>(write: () => Promise<T>) =>
      auditScope.run(
        {
          eventId: "00000000-0000-4000-8000-000000000099",
          actor: { kind: "system" },
          requestId: "missing-request",
        },
        write,
      );
    await expect(missingAudit(() => set(60_000))).rejects.toThrow("audit event");
    expect(await platform.getAutomationTimeoutGrant(key)).toBeNull();
    await set(120_000);
    await expect(missingAudit(() => set(180_000))).rejects.toThrow("audit event");
    expect(await platform.getAutomationTimeoutGrant(key)).toMatchObject({ maxTimeoutMs: 120_000 });
    await expect(missingAudit(() => platform.deleteAutomationTimeoutGrant(key))).rejects.toThrow(
      "audit event",
    );
    expect(await platform.getAutomationTimeoutGrant(key)).toMatchObject({ maxTimeoutMs: 120_000 });
    const results = await Promise.allSettled([missingAudit(() => set(180_000)), set(240_000)]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(await platform.getAutomationTimeoutGrant(key)).toMatchObject({ maxTimeoutMs: 240_000 });
    expect(
      (
        await platform.store.listAutomationTimeoutGrantAuditEvents({
          automationId: deployment.automationId,
          environment: "local",
        })
      ).map((event) => event.change.metadata),
    ).toEqual([
      { maxTimeoutMs: 240_000, note: null, previousMaxTimeoutMs: 120_000 },
      { maxTimeoutMs: 120_000, note: null, previousMaxTimeoutMs: null },
    ]);
  });

  it("removes a per-automation timeout grant", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "da56032c-8b2d-5b8d-b9af-0bd11a39096e",
    });

    await platform.setAutomationTimeoutGrant({
      environment: "local",
      automationName: "hello-webhook",
      maxTimeoutMs: 10_800_000,
    });

    expect(
      await platform.deleteAutomationTimeoutGrant({
        environment: "local",
        automationName: "hello-webhook",
      }),
    ).toBe(true);
    expect(
      await platform.getAutomationTimeoutGrant({
        environment: "local",
        automationName: "hello-webhook",
      }),
    ).toBeNull();
    // Removing a grant that no longer exists is a no-op.
    expect(
      await platform.deleteAutomationTimeoutGrant({
        environment: "local",
        automationName: "hello-webhook",
      }),
    ).toBe(false);
  });

  it("rejects setting a timeout grant on an unknown automation", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await expect(
      platform.setAutomationTimeoutGrant({
        environment: "local",
        automationName: "nonexistent",
        maxTimeoutMs: 10_800_000,
      }),
    ).rejects.toMatchObject({ code: "ACTIVE_DEPLOYMENT_NOT_FOUND" });
  });

  it("accepts a deploy above the ceiling with a grant, and a smaller grant never lowers it", async () => {
    vi.stubEnv("SWIZZLE_MAX_RUN_TIMEOUT", "1h");
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const fixture = path.join(packageRoot, "test-fixtures/timeout-exceeds-platform-max");

    // Register the automation first (bypassing readiness) so it can receive a grant.
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: fixture,
      deploymentId: "22d48577-4772-52b8-8252-74637259d808",
      skipReadinessCheck: true,
    });

    // A grant at/above the fixture's 2h timeout lifts the ceiling; the deploy passes.
    await platform.setAutomationTimeoutGrant({
      environment: "local",
      automationName: "timeout-exceeds-platform-max",
      maxTimeoutMs: 3 * 60 * 60_000,
    });
    const granted = await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: fixture,
      deploymentId: "0aac1b77-b79b-5f01-ade8-8e20557d394e",
      force: true,
    });
    expect(granted.readiness.status).toBe("ready");

    // A grant smaller than the global ceiling must not lower it: 2h is rejected again.
    await platform.setAutomationTimeoutGrant({
      environment: "local",
      automationName: "timeout-exceeds-platform-max",
      maxTimeoutMs: 30 * 60_000,
    });
    await expect(
      platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: fixture,
        deploymentId: "323ab25a-07a3-58c5-8be6-2e532c248379",
        force: true,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_REQUIREMENTS_UNMET" });
    // A dry run refuses what the deploy refuses.
    await expect(
      platform.checkDeployment({
        environment: "local",
        automationDirectory: fixture,
        force: true,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_REQUIREMENTS_UNMET" });
  });
});
