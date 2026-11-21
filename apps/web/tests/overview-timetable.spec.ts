import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  mockDashboardApi,
  PROJECT_ID,
  seededState,
  timetableRow,
  withRunOutcome,
} from "./dashboard-mock";

const HOUR = 60 * 60_000;
const atHour = (from: string, hour: number) =>
  new Date(Date.parse(from) + hour * HOUR).toISOString();

const row = (page: Page, name: string) =>
  page.getByTestId("automation-row").filter({ has: page.getByRole("link", { name, exact: true }) });

async function cellAt(page: Page, strip: Locator, iso: string): Promise<Locator> {
  const label = await page.evaluate((at) => {
    const start = new Date(at);
    start.setMinutes(0, 0, 0);
    return start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }, iso);
  return strip.locator(`.hour-cells i[data-tip^="${label} ·"]`);
}

test("an hour draws its runs, and its hover names the hour and the counts", async ({ page }) => {
  const state = seededState();
  const { timetable } = state.overview;
  const ok = atHour(timetable.from, 20);
  const mixed = atHour(timetable.from, 17);
  const cancelled = atHour(timetable.from, 14);
  const quiet = atHour(timetable.from, 11);
  for (const [at, outcome] of [
    [cancelled, "cancelled"],
    [mixed, "failed"],
    [mixed, "succeeded"],
    [ok, "succeeded"],
    [ok, "succeeded"],
  ] as const) {
    state.overview = withRunOutcome(state.overview, {
      automationSlug: "verify-vault",
      finishedAt: at,
      queuedAt: at,
      state: outcome,
    });
  }
  await mockDashboardApi(page, state);
  await page.goto("/");
  const strip = row(page, "verify-vault").locator(".hour-strip");
  await expect(strip.locator(".hour-cells i")).toHaveCount(24);

  const succeeded = await cellAt(page, strip, ok);
  await expect(succeeded).toHaveClass(/\bshort\b.*\bok\b/u);
  await expect(succeeded).toHaveAttribute("data-tip", /· 2 succeeded$/u);

  const failing = await cellAt(page, strip, mixed);
  await expect(failing).toHaveClass(/\bfull\b/u);
  await expect(failing).toHaveAttribute("data-tip", /· 1 succeeded, 1 failed$/u);
  expect(await failing.getAttribute("style")).toContain("var(--fail) max(4px, 50%)");
  expect(await failing.getAttribute("style")).toContain("var(--ok) calc(max(4px, 50%) + 2px)");

  const neutral = await cellAt(page, strip, cancelled);
  await expect(neutral).toHaveClass(/\bshort\b.*\bidle\b/u);
  await expect(neutral).toHaveAttribute("data-tip", /· 1 cancelled$/u);

  const empty = await cellAt(page, strip, quiet);
  await expect(empty).toHaveClass(/\bempty\b/u);
  await expect(empty).toHaveAttribute("data-tip", /· No runs$/u);

  await failing.hover();
  const tip = await failing.evaluate((cell) => {
    const after = getComputedStyle(cell, "::after");
    return { content: after.content, fontStyle: after.fontStyle };
  });
  expect(tip).toEqual({
    content: JSON.stringify(await failing.getAttribute("data-tip")),
    fontStyle: "normal",
  });
});

test("a deploy inside the window marks its version at its time", async ({ page }) => {
  const state = seededState();
  const { recentChanges, timetable } = state.overview;
  const [change] = recentChanges;
  if (change === undefined) throw new Error("Seed changed.");
  const deploy = (occurredAt: string, version: string) => ({
    ...change,
    change: { ...change.change, automationSlug: "verify-vault", version },
    id: `event-${version}`,
    occurredAt,
    target: { ...change.target, automationSlug: "verify-vault" },
    automationName: "verify-vault",
    automationSlug: "verify-vault",
  });
  const marks = [
    { at: atHour(timetable.from, 14.75), version: "2.0.0", within: 0.75 },
    { at: atHour(timetable.from, 18.25), version: "2.1.0", within: 0.25 },
  ];
  state.overview = {
    ...state.overview,
    recentChanges: marks.map((mark) => deploy(mark.at, mark.version)),
    timetable: {
      ...timetable,
      rows: [
        ...timetable.rows,
        timetableRow(
          "verify-vault",
          {},
          marks.map(({ at, version }) => ({ at, version })),
        ),
      ],
    },
  };
  await mockDashboardApi(page, state);
  await page.goto("/");

  const strip = row(page, "verify-vault").locator(".hour-strip");
  await expect(strip.locator(".hour-mark")).toHaveText(["v2.0.0", "v2.1.0"]);
  for (const [index, { at, within }] of marks.entries()) {
    const mark = await strip.locator(".hour-mark").nth(index).boundingBox();
    const hour = await (await cellAt(page, strip, at)).boundingBox();
    if (mark === null || hour === null) throw new Error("Not drawn.");
    expect(mark.x + mark.width / 2).toBeCloseTo(hour.x + within * hour.width, 0);
  }
});

test("automations with a failure come first, and a folder still narrows the list", async ({
  page,
}) => {
  const state = seededState();
  const failedAt = atHour(state.overview.timetable.from, 21);
  state.overview = withRunOutcome(state.overview, {
    automationSlug: "verify-ticker",
    finishedAt: failedAt,
    queuedAt: failedAt,
    state: "failed",
  });
  const now = new Date().toISOString();
  state.folders = {
    create: null,
    folders: [
      {
        createdAt: now,
        id: "folder-ops",
        name: "Ops",
        projectId: PROJECT_ID,
        refusal: null,
        sortOrder: 0,
        updatedAt: now,
      },
    ],
  };
  state.automations = state.automations.map((automation) =>
    automation.automationSlug === "verify-vault"
      ? { ...automation, folderId: "folder-ops", folderName: "Ops" }
      : automation,
  );
  await mockDashboardApi(page, state);
  await page.goto("/");

  const names = page.getByTestId("automation-row").locator(".name a");
  await expect(names).toHaveText(["verify-probe", "verify-ticker", "verify-vault", "fetch-sales"]);

  await page.getByRole("tab", { name: "Ops" }).click();
  await expect(names).toHaveText(["verify-vault"]);
  await expect(row(page, "verify-vault").locator(".hour-cells i")).toHaveCount(24);
  await page.getByRole("tab", { name: /^All/u }).click();
  await expect(names).toHaveCount(4);
});

test.describe("at phone width", () => {
  test.use({ viewport: { height: 844, width: 390 } });

  test("a row keeps name and next run on one line, the hours full width below", async ({
    page,
  }) => {
    await mockDashboardApi(page, seededState());
    await page.goto("/");
    const rows = page.getByTestId("automation-row");
    await expect(rows).toHaveCount(4);
    for (const one of await rows.all()) {
      const box = await one.boundingBox();
      const name = await one.locator(".name").boundingBox();
      const next = await one.locator(".next").boundingBox();
      const strip = await one.locator(".hour-strip").boundingBox();
      if (box === null || name === null || next === null || strip === null) {
        throw new Error("Not drawn.");
      }
      expect(next.y).toBe(name.y);
      expect(strip.y).toBeGreaterThanOrEqual(name.y + name.height);
      expect(strip.width).toBe(box.width - 32);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  });
});
