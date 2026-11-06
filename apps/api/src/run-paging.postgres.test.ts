import { createDashboardStore, createPostgresWorkerRegistry } from "@swizzle/db/postgres";
import { expect, it } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import { testApiTokenStore } from "../../../test/stores.js";
import { createAutomationFixture, deployFixture } from "../test/automations.js";
import { testPeople } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";
import { createDashboardDataProvider } from "./dashboard.js";

/**
 * 450 copies of a run: three share one queue time exactly at each step, and the three steps of a
 * group sit microseconds apart, inside one millisecond, where a cursor held in a Date would lose
 * its place.
 */
async function copyRun(runId: string): Promise<void> {
  await testDatabase().pool.query(
    `insert into runs
     select (jsonb_populate_record(run, jsonb_build_object(
       'id', gen_random_uuid(),
       'queue_job_id', 'copy-' || n,
       'status', case when n % 2 = 0 then 'failed' else 'succeeded' end,
       'queued_at', timestamptz '2026-03-01 12:00:00.000500+00'
         - make_interval(secs => (n / 9)) - make_interval(secs => ((n / 3) % 3) * 0.000001)
     ))).*
     from runs run, generate_series(0, 449) n
     where run.id = $1`,
    [runId],
  );
}

it("walks every run of a filter past the page cap without a gap or a repeat", async () => {
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
  const list = async (query: string) => {
    const response = await app.inject({
      headers: { authorization: owner.authorization },
      method: "GET",
      url: `/dashboard/runs?${query}`,
    });
    return response;
  };
  const walk = async (query: string) => {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? "" : `&cursor=${cursor}`;
      const page = (await list(`${query}${after}`)).json();
      pages.push(page.runs.map((run: { runId: string }) => run.runId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return pages;
  };

  const directory = await createAutomationFixture({ mainJs: "", name: "report", path: "/report" });
  expect((await deployFixture(app, directory, {}, { headers: owner })).statusCode).toBe(200);
  const started = await app.inject({
    headers: { authorization: owner.authorization },
    method: "POST",
    payload: {},
    url: "/automations/report/runs",
  });
  await copyRun(started.json().runId);

  const stored = await testDatabase().pool.query<{ id: string }>(
    "select id from runs order by queued_at desc, id desc",
  );
  const pages = await walk("limit=200");
  expect(pages.map((page) => page.length)).toEqual([200, 200, 51]);
  expect(pages.flat()).toEqual(stored.rows.map((row) => row.id));

  // A filter walks its own runs: half the copies failed.
  const failed = await walk("limit=200&status=failed");
  expect(failed.map((page) => page.length)).toEqual([200, 25]);
  expect(new Set(failed.flat()).size).toBe(225);

  // A run that arrives mid-walk lands above the cursor, so the walk neither repeats nor skips.
  const first = (await list("limit=100")).json();
  await app.inject({
    headers: { authorization: owner.authorization },
    method: "POST",
    payload: {},
    url: "/automations/report/runs",
  });
  const second = (await list(`limit=100&cursor=${first.nextCursor}`)).json();
  expect(second.runs.map((run: { runId: string }) => run.runId)).toEqual(
    stored.rows.slice(100, 200).map((row) => row.id),
  );

  expect((await list("cursor=not-a-cursor")).statusCode).toBe(400);
});
