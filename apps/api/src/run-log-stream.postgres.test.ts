import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";

import { ownerHeaders } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

// A subscription that stands at once and then hears nothing, as when the run's last status was
// published before it existed.
vi.mock("@swizzle/runtime/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@swizzle/runtime/platform")>()),
  subscribeRunLogEvents: vi.fn(async () => {}),
}));

const runId = "0f9c3a52-6d1e-4c53-9a77-3b5f3d6d1a10";

describe("GET /runs/:runId/logs/stream", () => {
  it("ends with 'end' when the run turns terminal before the subscription stands", async ({
    signal,
  }) => {
    const owner = await ownerHeaders();
    const platform = await testPlatform();
    const run = (status: string) => ({
      executions: [],
      automationSlug: "hello",
      environment: "staging",
      runId,
      status,
    });
    // The first read sees the run running; it finishes while the stream subscribes.
    const getPlatformRun = vi
      .fn()
      .mockResolvedValueOnce(run("running"))
      .mockResolvedValue(run("succeeded"));
    // The access check finds the run's automation before the stream opens.
    const findAutomation = async () => ({
      automationId: "5d2b3f0e-8c1a-4e6b-9f3d-2a7c1e4b8d90",
      automationSlug: "hello",
      projectId: DEFAULT_PROJECT_ID,
    });
    const app = await buildTestServer({
      platform: { ...platform, findAutomation, getPlatformRun } as unknown as typeof platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    // A stream that stays open never ends this read, and the test timeout aborts it.
    let text: string;
    try {
      const response = await fetch(`${address}/runs/${runId}/logs/stream`, {
        headers: owner,
        signal,
      });
      text = await response.text();
    } finally {
      await app.close();
    }

    expect(text).toContain('event: end\ndata: {"status":"succeeded"}');
  });
});
