import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { temporaryDirectory } from "../../../test/support.js";

import { createInMemoryRateLimiter } from "./rate-limit-enforcement.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = path.resolve(sourceRoot, "..");
const fixtureDirectory = path.join(packageRoot, "test-fixtures", "rate-limited-webhook");

describe("platform rate-limit enforcement at dequeue time", () => {
  it("delays a run when the rate-limit window is saturated and resumes once the window frees up", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-rate-limit-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });

    await platform.deployAutomationToPlatform({
      environment: "local",
      automationDirectory: fixtureDirectory,
      deploymentId: "85310dd8-9d71-55e1-8c1b-297755a4b336",
    });

    const runs = [];
    for (let i = 1; i <= 3; i += 1) {
      runs.push(
        await platform.startManualRun({
          environment: "local",
          automationName: "rate-limited-webhook",
          payload: { i },
        }),
      );
    }

    let fakeNow = 1_000_000;
    const rateLimiter = createInMemoryRateLimiter({ now: () => fakeNow });

    const firstProcessed = await platform.processNextPlatformRun({ rateLimiter });
    expect(firstProcessed?.status).toBe("succeeded");

    const secondProcessed = await platform.processNextPlatformRun({ rateLimiter });
    expect(secondProcessed?.status).toBe("succeeded");

    const thirdProcessed = await platform.processNextPlatformRun({ rateLimiter });
    expect(thirdProcessed).toBeNull();

    const thirdRunIdAfterDelay = runs[2]?.runId as string;
    expect((await platform.getPlatformRun(thirdRunIdAfterDelay)).status).toBe("queued");

    fakeNow += 60_001;

    const fourthProcessed = await platform.processNextPlatformRun({ rateLimiter });
    expect(fourthProcessed?.status).toBe("succeeded");
    expect(fourthProcessed?.runId).toBe(thirdRunIdAfterDelay);

    await platform.close();
  });
});
