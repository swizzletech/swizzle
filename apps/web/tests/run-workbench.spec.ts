import { expect, type Page, test } from "@playwright/test";

import {
  addOlderRuns,
  allRunPage,
  mockDashboardApi,
  seededState,
  setAllRunPage,
  setRunPages,
} from "./dashboard-mock";

test.use({ viewport: { height: 900, width: 1440 } });

const MANY = 450;

async function seeded(page: Page, path: string) {
  const state = seededState();
  const runs = addOlderRuns(state, MANY);
  await mockDashboardApi(page, state);
  await page.goto(path);
  await expect(page.getByTestId("run-row").first()).toBeVisible();
  return runs;
}

for (const [name, path] of [
  ["Runs", "/runs"],
  ["an automation's Runs tab", "/automations/verify-probe"],
] as const) {
  test(`${name} fills the window with two panes that scroll on their own`, async ({ page }) => {
    await seeded(page, path);
    const list = page.getByTestId("run-list-pane");
    const run = page.getByTestId("run-pane");
    await expect(page.getByTestId("run-panel")).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(900);
    const [listBox, runBox, cardBox] = await Promise.all([
      list.boundingBox(),
      run.boundingBox(),
      page.getByTestId("run-workbench").boundingBox(),
    ]);
    expect(listBox?.y).toBe(runBox?.y);
    expect(listBox?.height).toBe(runBox?.height);
    expect((cardBox?.y ?? 0) + (cardBox?.height ?? 0)).toBeLessThan(900);

    await list.evaluate((pane) => pane.scrollTo({ top: 400 }));
    await expect.poll(() => list.evaluate((pane) => pane.scrollTop)).toBe(400);
    expect(await run.evaluate((pane) => pane.scrollTop)).toBe(0);
  });
}

test("the automation's run list starts under its tabs, the flow above the run", async ({
  page,
}) => {
  await seeded(page, "/automations/verify-probe");

  const tabs = await page.getByRole("tablist", { name: "Automation" }).boundingBox();
  const first = await page.getByTestId("run-list-pane").boundingBox();
  expect((first?.y ?? 0) - ((tabs?.y ?? 0) + (tabs?.height ?? 0))).toBeLessThanOrEqual(17);
  await expect(page.getByTestId("run-row").first()).toBeInViewport({ ratio: 1 });

  const pane = page.getByTestId("run-pane");
  await expect(pane.locator("> *").first()).toHaveAttribute("data-testid", "flow-track");
  const station = (step: string) =>
    pane.locator(`[data-testid="station"][data-step="${step}"]`).boundingBox();
  await expect(pane.locator('[data-testid="station"][data-step="notify"]')).toBeVisible();
  const [fetch, notify] = await Promise.all([station("fetch"), station("notify")]);
  expect(fetch?.x).toBeLessThan(notify?.x ?? 0);

  await pane.getByRole("button", { name: /^Flow/u }).click();
  await expect(pane.getByTestId("track")).toHaveCount(0);
  await expect(page.getByTestId("run-panel")).toBeVisible();
});

test.describe("at midday", () => {
  const hour = new Date().getUTCHours();
  test.use({ timezoneId: `Etc/GMT${hour >= 12 ? "+" : "-"}${Math.abs(12 - hour)}` });

  test("the list groups by day under sticky headers, in rows of one height with no run id", async ({
    page,
  }) => {
    await seeded(page, "/runs");

    const list = page.getByTestId("run-list");
    await expect(list.getByRole("heading").first()).toContainText("Today");
    await expect(list.getByRole("heading").nth(1)).toContainText("Yesterday");

    const heights = await page
      .getByTestId("run-row")
      .evaluateAll((rows) => [...new Set(rows.map((row) => row.getBoundingClientRect().height))]);
    expect(heights).toEqual([56]);
    await expect(list).not.toContainText("70000000");

    const pane = page.getByTestId("run-list-pane");
    const header = list.getByRole("heading").first();
    const top = (await pane.boundingBox())?.y;
    await pane.evaluate((element) => element.scrollTo({ top: 200 }));
    await expect.poll(async () => (await header.boundingBox())?.y).toBe(top);
  });
});

test("Load older runs reaches every run of the filter, and only then says all", async ({
  page,
}) => {
  const runs = await seeded(page, "/runs");
  const total = runs.length;
  const count = page.getByTestId("run-count");
  await expect(count).toHaveText("100 newest runs loaded");
  await expect(page.getByTestId("page-head")).toContainText("100 newest · live");

  const older = page.getByRole("button", { name: "Load older runs" });
  for (const loaded of [200, 300, 400]) {
    await older.click();
    await expect(page.getByTestId("run-row")).toHaveCount(loaded);
    await expect(count).toHaveText(`${loaded} newest runs loaded`);
  }
  await older.click();
  await expect(page.getByTestId("run-row")).toHaveCount(total);
  await expect(count).toHaveText(`${total} runs, that is all of them`);
  await expect(page.getByTestId("page-head")).toContainText(`${total} runs · live`);
  await expect(older).toHaveCount(0);

  const ids = await page
    .getByTestId("run-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-run-id")));
  expect(new Set(ids).size).toBe(total);
});

test("the live refresh leaves 30 loaded pages in place and requests only the newest page", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);
  const state = seededState();
  addOlderRuns(state, 3_100);
  await mockDashboardApi(page, state);
  await page.goto("/runs");

  const rows = page.getByTestId("run-row");
  const older = page.getByTestId("run-list-end").getByRole("button", { name: "Load older runs" });
  const expectLoaded = async (count: number) => {
    await expect
      .poll(async () => {
        await page.clock.runFor(1);
        return await rows.count();
      })
      .toBe(count);
  };
  await expectLoaded(100);
  for (let loaded = 200; loaded <= 3_000; loaded += 100) {
    await older.evaluate((button: HTMLButtonElement) => button.click());
    await expectLoaded(loaded);
  }
  const lastLoaded = await rows.last().getAttribute("data-run-id");
  const [first, ...rest] = allRunPage(state).runs;
  if (first === undefined) throw new Error("Expected a newest run");
  setAllRunPage(state, [{ ...first, automationName: "refreshed-automation" }, ...rest]);
  const refreshStart = state.requests.length;

  await page.clock.runFor(5_000);
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return await rows.first().textContent();
    })
    .toContain("refreshed-automation");
  expect(
    state.requests
      .slice(refreshStart)
      .filter(
        (request) => request.pathname === "/dashboard/runs" && !request.search.has("parentRunId"),
      )
      .map((request) => request.search.get("cursor")),
  ).toEqual([null]);
  await expect(rows).toHaveCount(3_000);
  await expect(rows.last()).toHaveAttribute("data-run-id", lastLoaded ?? "");

  await older.evaluate((button: HTMLButtonElement) => button.click());
  await expectLoaded(3_100);
  await page.clock.resume();
  await rows.nth(2_999).click();
  await expect(rows.nth(2_999)).toHaveAttribute("aria-current", "true");
});

test("Load older runs can reach every run after a burst moves the newest page past history", async ({
  page,
}) => {
  const state = seededState();
  setAllRunPage(state, []);
  const initial = addOlderRuns(state, 250);
  const [first] = initial;
  if (first === undefined) throw new Error("Expected a newest run");
  const now = Date.now();
  const burst = Array.from({ length: 150 }, (_, index) => ({
    ...first,
    queuedAt: new Date(now - index * 1_000).toISOString(),
    runId: `80000000-aaaa-4bbb-8ccc-${String(index).padStart(12, "0")}`,
  }));
  const runs = [...burst, ...initial];
  await mockDashboardApi(page, state);
  await page.goto("/runs");

  const rows = page.getByTestId("run-row");
  const older = page.getByRole("button", { name: "Load older runs" });
  await expect(rows).toHaveCount(100);
  await older.click();
  await expect(rows).toHaveCount(200);

  const obsoletePage = (url: URL) =>
    url.pathname === "/api/dashboard/runs" && url.searchParams.get("cursor") === "200";
  let releaseObsoleteReply = () => {};
  const obsoleteReply = new Promise<void>((resolve) => {
    releaseObsoleteReply = resolve;
  });
  await page.route(
    obsoletePage,
    async (route) => {
      await obsoleteReply;
      await route.fallback();
    },
    { times: 1 },
  );
  try {
    const obsoleteRequest = page.waitForRequest((request) => obsoletePage(new URL(request.url())));
    await older.click();
    await obsoleteRequest;

    setRunPages(state, runs);

    await expect(rows.first()).toHaveAttribute(
      "data-run-id",
      "80000000-aaaa-4bbb-8ccc-000000000000",
    );
    await expect(rows).toHaveCount(100);
    const repageStart = state.requests.length;
    await older.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(rows).toHaveCount(200);
    expect(
      state.requests
        .slice(repageStart)
        .filter((request) => request.pathname === "/dashboard/runs" && request.search.has("cursor"))
        .map((request) => request.search.get("cursor")),
    ).toEqual(["100"]);
  } finally {
    releaseObsoleteReply();
  }
  for (const loaded of [300, 400]) {
    await older.click();
    await expect(rows).toHaveCount(loaded);
  }
  await expect(page.getByTestId("run-count")).toHaveText("400 runs, that is all of them");
  expect(
    await rows.evaluateAll((elements) => elements.map((row) => row.getAttribute("data-run-id"))),
  ).toEqual(runs.map((run) => run.runId));
});

test("the arrow keys walk the list and keep the selected row in view", async ({ page }) => {
  await seeded(page, "/runs");
  const rows = page.getByTestId("run-row");
  await rows.first().focus();

  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  const second = await rows.nth(1).getAttribute("data-run-id");
  await expect(page).toHaveURL(new RegExp(`selected=${second}`, "u"));

  await page.keyboard.press("ArrowUp");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(rows.first()).toHaveAttribute("aria-current", "true");

  for (let step = 0; step < 20; step += 1) await page.keyboard.press("ArrowDown");
  await expect(rows.nth(20)).toBeFocused();
  await expect(rows.nth(20)).toBeInViewport({ ratio: 1 });
  await page.goBack();
  await expect(page).not.toHaveURL(/selected=/u);
});

test("the run a link names shows selected in the list, however far down", async ({ page }) => {
  const state = seededState();
  const runs = addOlderRuns(state, 80);
  await mockDashboardApi(page, state);
  await page.goto(`/runs?selected=${runs.at(-1)?.runId}`);
  await expect(page.locator('.rrow[aria-current="true"]')).toBeInViewport({ ratio: 1 });
});
