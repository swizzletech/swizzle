import { appendFile } from "node:fs/promises";
import path from "node:path";
import { createDashboardStore, createPostgresWorkerRegistry } from "@swizzle/db/postgres";
import { Queue } from "bullmq";
import { expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import { testApiTokenStore } from "../../../test/stores.js";
import { createAutomationFixture, deployFixture } from "../test/automations.js";
import { testPeople } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";
import { createDashboardDataProvider } from "./dashboard.js";

async function failingAutomation() {
  vi.spyOn(Queue.prototype, "getJobCounts").mockRejectedValue(new Error("no Valkey"));
  const people = testPeople();
  const apiTokenStore = testApiTokenStore();
  const platform = await testPlatform();
  const app = await buildTestServer({
    apiTokenStore,
    auth: people.auth,
    dashboard: createDashboardDataProvider({
      dashboardStore: createDashboardStore({ client: testDatabase() }),
      platform,
      workerRegistry: createPostgresWorkerRegistry({ client: testDatabase() }),
    }),
    platform,
  });
  const owner = await people.bearer(apiTokenStore, "owner@office.test", "owner");
  const send = async (method: "GET" | "POST", url: string, payload?: object) => {
    const response = await app.inject({
      headers: { authorization: owner.authorization },
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode, `${method} ${url}`).toBeLessThan(300);
    return response.json();
  };
  const directory = await createAutomationFixture({
    mainJs: "process.exit(1);",
    name: "report",
    path: "/report",
  });
  await appendFile(
    path.join(directory, "config.yaml"),
    "runtime:\n  retry:\n    max_attempts: 1\n",
  );
  expect((await deployFixture(app, directory, {}, { headers: owner })).statusCode).toBe(200);
  const start = async (): Promise<string> =>
    (await send("POST", "/automations/report/runs", {})).runId;
  return {
    cancelled: async () => {
      const runId = await start();
      await send("POST", `/runs/${runId}/cancel`);
      return runId;
    },
    cancelledWithParent: async () => {
      const runId = await start();
      await platform.store.updateRunState({
        deadLetterReason: "parent-cancelled",
        finishedAt: new Date().toISOString(),
        runId,
        status: "dead-lettered",
      });
      return runId;
    },
    failed: async () => {
      const runId = await start();
      expect((await platform.processNextPlatformRun())?.status).toBe("dead-lettered");
      return runId;
    },
    failing: async () =>
      (await send("GET", "/dashboard/overview")).needsYou.filter(
        (item: { kind: string }) => item.kind === "failing",
      ),
    overview: async () => await send("GET", "/dashboard/overview"),
    send,
  };
}

it("counts a failed run beside a cancelled one as the only failure", async () => {
  const { cancelled, failed, overview, send } = await failingAutomation();
  const failedRun = await failed();
  await cancelled();

  const { last24h, lastFailureAt } = await overview();
  expect(last24h.failed + last24h["dead-lettered"]).toBe(1);
  expect(Object.values<number>(last24h).reduce((sum, count) => sum + count, 0)).toBe(2);
  expect(lastFailureAt).toBe((await send("GET", `/dashboard/runs/${failedRun}`)).finishedAt);
});

it("reads a run a person cancelled as no failure at all", async () => {
  const { cancelled, failing, overview } = await failingAutomation();
  await cancelled();

  expect(await overview()).toMatchObject({
    last24h: { "dead-lettered": 0, failed: 0 },
    lastFailureAt: null,
  });
  expect(await failing()).toEqual([]);
});

it("keeps a failure in Needs you when a person cancels the run after it", async () => {
  const { cancelled, failed, failing } = await failingAutomation();
  const failedRun = await failed();
  await cancelled();

  expect(await failing()).toEqual([
    expect.objectContaining({ failedRuns: 1, kind: "failing", lastFailedRunId: failedRun }),
  ]);
});

it("lists a cancelled run under All but not under Failed, on every page", async () => {
  const { cancelled, failed, send } = await failingAutomation();
  const failedRun = await failed();
  const cancelledRun = await cancelled();

  const failures = await send("GET", "/dashboard/runs?failedOnly=true");
  expect(failures.runs.map((run: { runId: string }) => run.runId)).toEqual([failedRun]);

  const first = await send("GET", "/dashboard/runs?limit=1");
  expect(first.runs).toEqual([
    expect.objectContaining({ runId: cancelledRun, state: "cancelled" }),
  ]);
  const cursor = encodeURIComponent(first.nextCursor);
  const second = await send("GET", `/dashboard/runs?limit=1&cursor=${cursor}`);
  expect(second.runs).toEqual([
    expect.objectContaining({ runId: failedRun, state: "dead-lettered" }),
  ]);
});

it("tells the health strip which of an automation's runs a person cancelled", async () => {
  const { cancelled, failed, send } = await failingAutomation();
  await failed();
  await cancelled();

  const { automations } = await send("GET", "/dashboard/automations");
  expect(automations[0].recentRuns.map((run: { state: string }) => run.state)).toEqual([
    "cancelled",
    "dead-lettered",
  ]);
});

it("reads either recorded cancellation as cancelled in detail, lists and overview counts", async () => {
  const { cancelled, cancelledWithParent, failed, overview, send } = await failingAutomation();
  const failedId = await failed();
  const userCancelledId = await cancelled();
  const parentCancelledId = await cancelledWithParent();

  for (const runId of [userCancelledId, parentCancelledId]) {
    expect(await send("GET", `/dashboard/runs/${runId}`)).toMatchObject({ state: "cancelled" });
  }
  const failures = await send("GET", "/dashboard/runs?failedOnly=true");
  expect(failures.runs.map((run: { runId: string }) => run.runId)).toEqual([failedId]);
  const result = await overview();
  expect(result.last24h).toMatchObject({ cancelled: 2, "dead-lettered": 1 });
  const hours: Record<string, number>[] = result.timetable.rows[0].hours;
  expect(hours.reduce((sum, hour) => sum + (hour.cancelled ?? 0), 0)).toBe(2);
  expect(hours.reduce((sum, hour) => sum + (hour["dead-lettered"] ?? 0), 0)).toBe(1);
});
