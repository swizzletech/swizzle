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

// 20:07 on a clock five and a half hours east of UTC: the timetable's last hour starts at 20:00
// there, so its first hour starts at 21:00 the day before, 15:30 UTC.
const NOW = new Date("2026-11-06T14:37:00.000Z");
const FROM = "2026-11-05T15:30:00.000Z";
const at = (hours: number, minutes = 10) =>
  new Date(Date.parse(FROM) + hours * 3_600_000 + minutes * 60_000).toISOString();

/** An owner's API over `report`, whose run fails when its payload says so. */
async function reportAutomation() {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  // Tests run without Valkey; the queue counts are not under test.
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
    mainJs: [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (JSON.parse(input).fail) process.exit(1);",
      "  console.log('{}');",
      "});",
    ].join("\n"),
    name: "report",
    path: "/report",
  });
  await appendFile(
    path.join(directory, "config.yaml"),
    "runtime:\n  retry:\n    max_attempts: 1\n",
  );
  expect((await deployFixture(app, directory, {}, { headers: owner })).statusCode).toBe(200);
  const queuedAt = async (runId: string, iso: string) => {
    await testDatabase().pool.query("update runs set queued_at = $2 where id = $1", [runId, iso]);
  };
  const run = async (payload: object, iso: string): Promise<string> => {
    const { runId } = await send("POST", "/automations/report/runs", payload);
    await platform.processNextPlatformRun();
    await queuedAt(runId, iso);
    return runId;
  };
  return {
    cancelled: async (iso: string) => {
      const { runId } = await send("POST", "/automations/report/runs", {});
      await send("POST", `/runs/${runId}/cancel`);
      await queuedAt(runId, iso);
    },
    deployedAt: async (iso: string) => {
      await testDatabase().pool.query(
        "update audit_events set occurred_at = $1 where change->>'kind' = 'deployment'",
        [iso],
      );
    },
    failed: async (iso: string) => await run({ fail: true }, iso),
    succeeded: async (iso: string) => await run({}, iso),
    timetable: async () =>
      (await send("GET", "/dashboard/overview?utcOffset=330")).timetable as {
        from: string;
        rows: { automationSlug: string; deployments: unknown[]; hours: object[] }[];
      },
  };
}

// The hours follow the viewer's clock, each counts its runs by the state their owner reads, and a
// run a person cancelled stays apart from the failures.
it("counts each of the viewer's last 24 hours by run state", async () => {
  const report = await reportAutomation();
  await report.succeeded(at(-1, 59));
  await report.succeeded(at(0));
  await report.failed(at(5));
  await report.succeeded(at(5, 40));
  await report.cancelled(at(10));

  const timetable = await report.timetable();
  expect(timetable.from).toBe(FROM);
  const hours: object[] = Array.from({ length: 24 }, () => ({}));
  hours[0] = { succeeded: 1 };
  hours[5] = { "dead-lettered": 1, succeeded: 1 };
  hours[10] = { cancelled: 1 };
  expect(timetable.rows).toEqual([expect.objectContaining({ automationSlug: "report", hours })]);
});

it("marks a deploy inside the window at its time and leaves out one before it", async () => {
  const report = await reportAutomation();
  await report.deployedAt(at(13, 21));
  expect((await report.timetable()).rows).toEqual([
    {
      automationSlug: "report",
      deployments: [{ at: at(13, 21), version: "1.0.0" }],
      hours: Array.from({ length: 24 }, () => ({})),
    },
  ]);

  await report.deployedAt(at(-1));
  expect((await report.timetable()).rows).toEqual([]);
});
