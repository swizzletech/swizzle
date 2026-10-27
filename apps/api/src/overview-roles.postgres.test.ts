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

// The dashboard offers a person only what their role lets them act on: the steps to a first deploy
// and what an agent fixes need editor, and a run that waits for a worker needs an instance owner or
// admin to grant or wake one.
it("shows a viewer neither the first-deploy steps nor a failing automation to fix", async () => {
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
  const viewer = await people.bearer(apiTokenStore, "viewer@office.test");
  const editor = await people.bearer(apiTokenStore, "editor@office.test");
  const send = async (
    who: { readonly authorization: string },
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      headers: { authorization: who.authorization },
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode, `${method} ${url}`).toBeLessThan(300);
    return response.json();
  };
  for (const [who, role] of [
    [viewer, "viewer"],
    [editor, "editor"],
  ] as const) {
    await send(owner, "PUT", "/projects/default/grants", { role, user: who.userId });
  }
  const overview = async (who: { readonly authorization: string }) =>
    await send(who, "GET", "/dashboard/overview");

  expect((await overview(viewer)).deploy).toEqual(
    expect.objectContaining({ required: "editor", role: "viewer" }),
  );
  expect((await overview(editor)).deploy).toBeNull();

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
  const { runId } = await send(owner, "POST", "/automations/report/runs", {});
  expect((await platform.processNextPlatformRun())?.status).toBe("dead-lettered");
  // Hand to agent on the failed run's panel asks for a change and a deploy.
  const handOff = async (who: { readonly authorization: string }) =>
    (await send(who, "GET", `/dashboard/runs/${runId}`)).refusals.edit;
  expect(await handOff(viewer)).toEqual(
    expect.objectContaining({ required: "editor", role: "viewer" }),
  );
  expect(await handOff(editor)).toBeNull();

  expect(await overview(viewer)).toEqual(
    expect.objectContaining({ complete: false, needsYou: [] }),
  );
  // An editor does not act on the instance, so their Needs you never reads as all of it.
  expect((await overview(editor)).complete).toBe(false);
  expect((await overview(editor)).needsYou).toEqual([
    expect.objectContaining({
      automation: expect.objectContaining({ automationSlug: "report" }),
      kind: "failing",
    }),
  ]);
  // No worker serves the group gpu, so a run there waits for an owner or admin to grant one.
  const pinned = await createAutomationFixture({ mainJs: "", name: "render", path: "/render" });
  await appendFile(path.join(pinned, "config.yaml"), "runtime:\n  profile: gpu\n");
  expect((await deployFixture(app, pinned, {}, { headers: owner })).statusCode).toBe(200);
  await send(owner, "POST", "/automations/render/runs", {});
  expect((await overview(viewer)).needsYou).toEqual([]);
  expect((await overview(editor)).needsYou.map((item: { kind: string }) => item.kind)).toEqual([
    "failing",
  ]);
  expect(await overview(owner)).toEqual(
    expect.objectContaining({
      complete: true,
      needsYou: expect.arrayContaining([expect.objectContaining({ kind: "waiting-for-worker" })]),
    }),
  );
  // A token limited to an environment reads everything there but grants no worker.
  const { token } = await apiTokenStore.createToken({
    holder: { kind: "person", userId: owner.userId },
    issuedBy: { id: owner.userId, name: "owner@office.test" },
    name: "local only",
    scope: { environments: ["local"], projectIds: null, role: "admin" },
  });
  const scoped = await overview({ authorization: `Bearer ${token}` });
  expect(scoped.complete).toBe(false);
  expect(scoped.needsYou.map((item: { kind: string }) => item.kind)).toEqual(["failing"]);

  // The steps end in a deploy that names no project, which lands in the default project, so editor
  // elsewhere does not offer them: the Overview refuses what the deploy refuses.
  await send(owner, "POST", "/projects", { name: "Office", slug: "office" });
  await send(owner, "PUT", "/projects/office/grants", { role: "editor", user: viewer.userId });
  expect(await overview(viewer)).toEqual(
    expect.objectContaining({
      complete: false,
      deploy: expect.objectContaining({ required: "editor", role: "viewer" }),
      needsYou: [],
    }),
  );
  const memo = await createAutomationFixture({ mainJs: "", name: "memo", path: "/memo" });
  expect((await deployFixture(app, memo, {}, { headers: viewer })).statusCode).toBe(403);
  await app.close();
});
