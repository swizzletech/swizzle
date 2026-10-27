import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";

// Chain triggers: cycle detection, single-source payloads and multi-source joins.

describe("platform chain triggers", () => {
  it("marks self-referential chain triggers invalid instead of creating a run loop", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const sourceDirectory = await createAutomationFixture({
      name: "self-chain",
      triggerLines: ["  type: webhook", "  path: /self-chain"],
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: sourceDirectory,
      deploymentId: "73c101c5-ba62-5e7a-b477-4d1afde1f44f",
    });

    const chainDirectory = await createAutomationFixture({
      name: "self-chain",
      triggerLines: ["  type: chain", "  source: self-chain"],
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: chainDirectory,
      deploymentId: "96a583a6-01bd-5f18-a545-c417bc0ac5a5",
    });

    const trigger = await platform.getAutomationTrigger("self-chain", "local");
    expect(trigger).toMatchObject({
      errorCode: "TRIGGER_CONFIGURATION_INVALID",
      status: "invalid",
      triggerType: "chain",
    });
    expect(trigger.errorMessage).toContain("would create a cycle");
  });

  it("marks indirect chain cycles invalid instead of enabling recursive triggers", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationA = await createAutomationFixture({
      name: "chain-a",
      triggerLines: ["  type: webhook", "  path: /chain-a"],
    });
    const automationB = await createAutomationFixture({
      name: "chain-b",
      triggerLines: ["  type: chain", "  source: chain-a"],
    });
    const automationABackEdge = await createAutomationFixture({
      name: "chain-a",
      triggerLines: ["  type: chain", "  source: chain-b"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: automationA,
      deploymentId: "18921eba-5641-5285-8e18-f593c8ede2b2",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: automationB,
      deploymentId: "0ad4ecc8-bd15-5765-9b4b-269695297ee0",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: automationABackEdge,
      deploymentId: "2d6419a3-1523-573e-9a7b-542ca9f17913",
    });

    const trigger = await platform.getAutomationTrigger("chain-a", "local");
    expect(trigger).toMatchObject({
      errorCode: "TRIGGER_CONFIGURATION_INVALID",
      status: "invalid",
      triggerType: "chain",
    });
    expect(trigger.errorMessage).toContain("would create a cycle");

    const unaffectedTrigger = await platform.getAutomationTrigger("chain-b", "local");
    expect(unaffectedTrigger).toMatchObject({
      chainSourceAutomationId: trigger.automationId,
      status: "active",
      triggerType: "chain",
    });
  });

  it("runs a single-source chain child with the source result as its payload", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const source = await createAutomationFixture({
      mainJs: ["console.log(JSON.stringify({ source: true }));", ""].join("\n"),
      name: "single-chain-source",
      triggerLines: ["  type: webhook", "  path: /single-chain-source"],
    });
    const child = await createAutomationFixture({
      mainJs: [
        "const chunks = [];",
        "process.stdin.on('data', (chunk) => chunks.push(chunk));",
        "process.stdin.on('end', () => {",
        "  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');",
        "  console.log(JSON.stringify({ received: payload }));",
        "});",
        "",
      ].join("\n"),
      name: "single-chain-child",
      triggerLines: ["  type: chain", "  source: single-chain-source"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: source,
      deploymentId: "974f306f-1625-5552-9a3d-6e472d615319",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: child,
      deploymentId: "4ac53c9b-9400-52ef-98cf-37f6d9808633",
    });

    const sourceRun = await platform.startManualRun({
      environment: "local",
      automationName: "single-chain-source",
      payload: { root: true },
    });
    const processedSource = await platform.processNextPlatformRun();
    const processedChild = await platform.processNextPlatformRun();

    expect(processedSource).toMatchObject({
      result: { source: true },
      runId: sourceRun.runId,
      status: "succeeded",
    });
    expect(processedChild).toMatchObject({
      automationName: "single-chain-child",
      chainOriginRunId: sourceRun.runId,
      chainSourceRunIds: [sourceRun.runId],
      result: { received: { source: true } },
      status: "succeeded",
      triggerType: "chain",
    });
  });

  it("fires a multi-source chain join once all source runs succeed for the same origin", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const origin = await createAutomationFixture({
      mainJs: ["console.log(JSON.stringify({ origin: true }));", ""].join("\n"),
      name: "join-origin",
      triggerLines: ["  type: webhook", "  path: /join-origin"],
    });
    const reviewer = await createAutomationFixture({
      mainJs: ["console.log(JSON.stringify({ reviewer: true }));", ""].join("\n"),
      name: "reviewer",
      triggerLines: ["  type: chain", "  source: join-origin"],
    });
    const verifier = await createAutomationFixture({
      mainJs: ["console.log(JSON.stringify({ verifier: true }));", ""].join("\n"),
      name: "e2e-verifier",
      triggerLines: ["  type: chain", "  source: join-origin"],
    });
    const joiner = await createAutomationFixture({
      mainJs: [
        "const chunks = [];",
        "process.stdin.on('data', (chunk) => chunks.push(chunk));",
        "process.stdin.on('end', () => {",
        "  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');",
        "  console.log(JSON.stringify(payload));",
        "});",
        "",
      ].join("\n"),
      name: "joiner",
      triggerLines: ["  type: chain", "  sources:", "    - reviewer", "    - e2e-verifier"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: origin,
      deploymentId: "496ea100-0ea7-5055-b502-c0bcbb1437e8",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: reviewer,
      deploymentId: "b0be5ee6-904b-5690-b582-e7fa65d3835a",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: verifier,
      deploymentId: "fd3e0fb6-a701-510c-82ed-aff202675b47",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: joiner,
      deploymentId: "a023a8b2-6ecd-5775-8349-021d3cff5f87",
    });

    const joinTrigger = await platform.getAutomationTrigger("joiner", "local");
    expect(joinTrigger).toMatchObject({
      chainOnStatus: "all-succeeded",
      chainPayloadMode: "results",
      chainSourceAutomationId: null,
      status: "active",
    });
    expect(joinTrigger.chainSourceAutomationIds).toHaveLength(2);

    const originRun = await platform.startManualRun({
      environment: "local",
      automationName: "join-origin",
      payload: { root: true },
    });
    const processedOrigin = await platform.processNextPlatformRun();
    const firstSource = await platform.processNextPlatformRun({ automationName: "reviewer" });
    const reviewerDeployment = await platform.store.getActiveDeploymentBySlug("reviewer", "local");
    expect(reviewerDeployment).not.toBeNull();
    if (reviewerDeployment === null) {
      throw new Error("Expected reviewer deployment.");
    }
    const duplicateReviewerRunId = randomUUID();
    await platform.store.createRun({
      attemptsMax: 1,
      automationId: reviewerDeployment.automationId,
      chainOriginRunId: originRun.runId,
      chainSourceRunIds: [originRun.runId],
      deploymentId: reviewerDeployment.deploymentId,
      payload: { root: true },
      queueJobId: duplicateReviewerRunId,
      queueName: "platform-runs--host-default",
      runId: duplicateReviewerRunId,
      triggerType: "chain",
      versionId: reviewerDeployment.versionId,
    });
    await platform.store.updateRunState({
      attemptsMade: 1,
      finishedAt: new Date(Date.now() + 1_000).toISOString(),
      result: { reviewer: "later-duplicate" },
      runId: duplicateReviewerRunId,
      startedAt: new Date().toISOString(),
      status: "succeeded",
    });
    const secondSource = await platform.processNextPlatformRun({ automationName: "e2e-verifier" });
    const joinRun = await platform.processNextPlatformRun();

    expect(processedOrigin).toMatchObject({ runId: originRun.runId, status: "succeeded" });
    expect([firstSource?.automationName, secondSource?.automationName].sort()).toEqual([
      "e2e-verifier",
      "reviewer",
    ]);
    expect(firstSource?.chainOriginRunId).toBe(originRun.runId);
    expect(secondSource?.chainOriginRunId).toBe(originRun.runId);
    expect(joinRun).toMatchObject({
      automationName: "joiner",
      chainOriginRunId: originRun.runId,
      status: "succeeded",
    });
    expect(joinRun?.chainSourceRunIds.toSorted()).toEqual(
      [firstSource?.runId, secondSource?.runId].toSorted(),
    );
    expect(firstSource?.chainSourceRunIds).toEqual([originRun.runId]);
    expect(joinRun?.result).toEqual({
      origin: { automation: "join-origin", runId: originRun.runId },
      results: {
        "e2e-verifier": { verifier: true },
        reviewer: { reviewer: true },
      },
    });

    expect(await platform.processNextPlatformRun()).toBeNull();
  });

  it("fires a multi-source chain join once when source runs complete in reverse order", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const origin = await createAutomationFixture({
      mainJs: ["console.log(JSON.stringify({ origin: true }));", ""].join("\n"),
      name: "reverse-join-origin",
      triggerLines: ["  type: webhook", "  path: /reverse-join-origin"],
    });
    const reviewer = await createAutomationFixture({
      mainJs: ["console.log(JSON.stringify({ reviewer: true }));", ""].join("\n"),
      name: "reverse-reviewer",
      triggerLines: ["  type: chain", "  source: reverse-join-origin"],
    });
    const verifier = await createAutomationFixture({
      mainJs: ["console.log(JSON.stringify({ verifier: true }));", ""].join("\n"),
      name: "reverse-e2e-verifier",
      triggerLines: ["  type: chain", "  source: reverse-join-origin"],
    });
    const joiner = await createAutomationFixture({
      mainJs: [
        "const chunks = [];",
        "process.stdin.on('data', (chunk) => chunks.push(chunk));",
        "process.stdin.on('end', () => {",
        "  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');",
        "  console.log(JSON.stringify(payload));",
        "});",
        "",
      ].join("\n"),
      name: "reverse-joiner",
      triggerLines: [
        "  type: chain",
        "  sources:",
        "    - reverse-reviewer",
        "    - reverse-e2e-verifier",
      ],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: origin,
      deploymentId: "d3f0177b-e9db-5bd3-ad0a-b98e704446b1",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: verifier,
      deploymentId: "8c6cb07c-bcc2-544c-b1ea-c0902ae1f11a",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: reviewer,
      deploymentId: "c3a6e786-41e7-5356-a09e-e244da4789f1",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: joiner,
      deploymentId: "19966a04-c30e-5900-87ea-6c4c7f849db4",
    });

    const originRun = await platform.startManualRun({
      environment: "local",
      automationName: "reverse-join-origin",
      payload: { root: true },
    });
    const processedOrigin = await platform.processNextPlatformRun();
    const verifierRun = await platform.processNextPlatformRun({
      automationName: "reverse-e2e-verifier",
    });
    const reviewerRun = await platform.processNextPlatformRun({
      automationName: "reverse-reviewer",
    });
    const joinRun = await platform.processNextPlatformRun();

    expect(processedOrigin).toMatchObject({ runId: originRun.runId, status: "succeeded" });
    expect(verifierRun).toMatchObject({
      automationName: "reverse-e2e-verifier",
      chainOriginRunId: originRun.runId,
      status: "succeeded",
    });
    expect(reviewerRun).toMatchObject({
      automationName: "reverse-reviewer",
      chainOriginRunId: originRun.runId,
      status: "succeeded",
    });
    expect(joinRun).toMatchObject({
      automationName: "reverse-joiner",
      chainOriginRunId: originRun.runId,
      status: "succeeded",
    });
    expect(joinRun?.result).toEqual({
      origin: { automation: "reverse-join-origin", runId: originRun.runId },
      results: {
        "reverse-e2e-verifier": { verifier: true },
        "reverse-reviewer": { reviewer: true },
      },
    });

    expect(await platform.processNextPlatformRun()).toBeNull();
  });

  it.each(["dead-letter-reviewer", "dead-letter-verifier"])(
    "does not fire a multi-source chain join when a source dead-letters and %s finishes first",
    async (firstSource) => {
      const stateDirectory = await temporaryDirectory("swizzle-platform-");

      const platform = await testPlatform({
        artifactsDirectory: path.join(stateDirectory, "artifacts"),
      });
      const origin = await createAutomationFixture({
        mainJs: ["console.log(JSON.stringify({ origin: true }));", ""].join("\n"),
        name: "dead-letter-origin",
        triggerLines: ["  type: webhook", "  path: /dead-letter-origin"],
      });
      const reviewer = await createAutomationFixture({
        mainJs: ["console.log(JSON.stringify({ reviewer: true }));", ""].join("\n"),
        name: "dead-letter-reviewer",
        triggerLines: ["  type: chain", "  source: dead-letter-origin"],
      });
      const verifier = await createAutomationFixture({
        configLines: ["runtime:", "  retry:", "    max_attempts: 1"],
        mainJs: ["process.stderr.write('verification failed\\n');", "process.exit(1);", ""].join(
          "\n",
        ),
        name: "dead-letter-verifier",
        triggerLines: ["  type: chain", "  source: dead-letter-origin"],
      });
      const joiner = await createAutomationFixture({
        name: "dead-letter-joiner",
        triggerLines: [
          "  type: chain",
          "  sources:",
          "    - dead-letter-reviewer",
          "    - dead-letter-verifier",
        ],
      });

      await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: origin,
        deploymentId: "3cc11952-d09a-531d-b2a3-516bcc19c270",
      });
      await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: reviewer,
        deploymentId: "63f2aad7-485b-5c97-9ca9-14facf35d2bf",
      });
      await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: verifier,
        deploymentId: "bd5a0c31-b8b2-5783-8694-8e6c937cc11d",
      });
      await platform.deployAutomationToPlatform({
        environment: "local",
        automationDirectory: joiner,
        deploymentId: "8e1a9622-c2a5-5b74-a6a1-4e484b4273b4",
      });

      await platform.startManualRun({
        environment: "local",
        automationName: "dead-letter-origin",
        payload: {},
      });
      expect(await platform.processNextPlatformRun()).toMatchObject({
        automationName: "dead-letter-origin",
        status: "succeeded",
      });
      const sources = [
        await platform.processNextPlatformRun({ automationName: firstSource }),
        await platform.processNextPlatformRun(),
      ];
      expect(sources[0]?.automationName).toBe(firstSource);
      expect(sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ automationName: "dead-letter-reviewer", status: "succeeded" }),
          expect.objectContaining({
            automationName: "dead-letter-verifier",
            status: "dead-lettered",
          }),
        ]),
      );
      expect(await platform.processNextPlatformRun()).toBeNull();
    },
  );

  it("audits and skips uncorrelated successful source runs for multi-source joins", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const reviewer = await createAutomationFixture({
      name: "uncorrelated-reviewer",
      triggerLines: ["  type: webhook", "  path: /uncorrelated-reviewer"],
    });
    const verifier = await createAutomationFixture({
      name: "uncorrelated-verifier",
      triggerLines: ["  type: webhook", "  path: /uncorrelated-verifier"],
    });
    const joiner = await createAutomationFixture({
      name: "uncorrelated-joiner",
      triggerLines: [
        "  type: chain",
        "  sources:",
        "    - uncorrelated-reviewer",
        "    - uncorrelated-verifier",
      ],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: reviewer,
      deploymentId: "17087564-40a1-52f4-8c85-dfd5187e42c2",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: verifier,
      deploymentId: "a8d5e4d0-bd43-51bb-84a2-058e6b2bcaa0",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: joiner,
      deploymentId: "4464045a-b7e7-5d09-9c49-67210e69cd97",
    });

    const sourceRun = await platform.startManualRun({
      environment: "local",
      automationName: "uncorrelated-reviewer",
      payload: {},
    });
    await platform.processNextPlatformRun();

    const auditEvents = await platform.listAutomationTriggerAuditEvents(
      "uncorrelated-joiner",
      "local",
    );
    expect(auditEvents.map((event) => event.change)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "chain_join_skipped",
          metadata: expect.objectContaining({
            reason: "uncorrelated",
            sourceRunId: sourceRun.runId,
          }),
          runId: null,
        }),
      ]),
    );
    expect(await platform.processNextPlatformRun()).toBeNull();
  });

  it("marks indirect chain cycles through sources invalid", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-platform-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const automationA = await createAutomationFixture({
      name: "multi-chain-a",
      triggerLines: ["  type: webhook", "  path: /multi-chain-a"],
    });
    const automationB = await createAutomationFixture({
      name: "multi-chain-b",
      triggerLines: ["  type: chain", "  source: multi-chain-a"],
    });
    const automationC = await createAutomationFixture({
      name: "multi-chain-c",
      triggerLines: ["  type: webhook", "  path: /multi-chain-c"],
    });
    const automationABackEdge = await createAutomationFixture({
      name: "multi-chain-a",
      triggerLines: ["  type: chain", "  sources:", "    - multi-chain-b", "    - multi-chain-c"],
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: automationA,
      deploymentId: "eba50893-f03b-5b48-a6aa-e4e72ab82aa5",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: automationB,
      deploymentId: "38633830-1d40-59fc-9f63-b99363ef9f51",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: automationC,
      deploymentId: "4ac7b70e-87d9-568a-8203-2009e353e47e",
    });
    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: automationABackEdge,
      deploymentId: "3f74bb90-8360-5302-ab29-62e2fe69383f",
    });

    const trigger = await platform.getAutomationTrigger("multi-chain-a", "local");
    expect(trigger).toMatchObject({
      errorCode: "TRIGGER_CONFIGURATION_INVALID",
      status: "invalid",
      triggerType: "chain",
    });
    expect(trigger.errorMessage).toContain("would create a cycle");
  });
});
