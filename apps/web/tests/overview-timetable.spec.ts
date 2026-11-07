import { expect, type Locator, type Page, test } from "@playwright/test";

import type { RunListItem } from "../src/lib/api";
import {
  type MockState,
  mockDashboardApi,
  OK_RUN_ID,
  PROJECT_ID,
  seededState,
} from "./dashboard-mock";

// The Overview's automation list is a timetable: per automation 24 hourly cells, a deploy mark at
// its time, and the next run. Each hour is found by the clock time its hover names, so a test
// that crosses a full hour still finds the hour it seeded.

const HOUR = 60 * 60_000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

/** A top-level run of `slug`, queued at `queuedAt`, in the state its owner reads. */
function runOf(
  state: MockState,
  slug: string,
  queuedAt: string,
  outcome: "succeeded" | "failed" | "cancelled",
): RunListItem {
  const ok = state.runs.find((run) => run.runId === OK_RUN_ID);
  if (ok === undefined) throw new Error("Seed changed.");
  return {
    ...ok,
    automationName: slug,
    automationSlug: slug,
    deadLetterReason: outcome === "cancelled" ? "user-cancelled" : null,
    finishedAt: queuedAt,
    queuedAt,
    runId: crypto.randomUUID(),
    startedAt: queuedAt,
    state: outcome,
    status: outcome === "cancelled" ? "dead-lettered" : outcome,
  };
}

const row = (page: Page, name: string) =>
  page.getByTestId("automation-row").filter({ has: page.getByRole("link", { name, exact: true }) });

/** The cell of the hour that holds `iso`, named by the clock time the viewer's browser shows. */
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
  const [ok, mixed, cancelled, quiet] = [3, 6, 9, 12].map((hours) => hoursAgo(hours + 0.5));
  state.runs.push(
    runOf(state, "verify-vault", ok as string, "succeeded"),
    runOf(state, "verify-vault", ok as string, "succeeded"),
    runOf(state, "verify-vault", mixed as string, "failed"),
    runOf(state, "verify-vault", mixed as string, "succeeded"),
    runOf(state, "verify-vault", cancelled as string, "cancelled"),
  );
  await mockDashboardApi(page, state);
  await page.goto("/");
  const strip = row(page, "verify-vault").locator(".hour-strip");
  await expect(strip.locator(".hour-cells i")).toHaveCount(24);

  const succeeded = await cellAt(page, strip, ok as string);
  await expect(succeeded).toHaveClass(/\bshort\b.*\bok\b/u);
  await expect(succeeded).toHaveAttribute("data-tip", /· 2 succeeded$/u);

  const failing = await cellAt(page, strip, mixed as string);
  await expect(failing).toHaveClass(/\bfull\b/u);
  await expect(failing).toHaveAttribute("data-tip", /· 1 succeeded, 1 failed$/u);
  // The failed half in red at the foot, the succeeded half above it.
  expect(await failing.getAttribute("style")).toContain("var(--fail) max(4px, 50%)");
  expect(await failing.getAttribute("style")).toContain("var(--ok) calc(max(4px, 50%) + 2px)");

  const neutral = await cellAt(page, strip, cancelled as string);
  await expect(neutral).toHaveClass(/\bshort\b.*\bidle\b/u);
  await expect(neutral).toHaveAttribute("data-tip", /· 1 cancelled$/u);

  const empty = await cellAt(page, strip, quiet as string);
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

test("a deploy inside the window marks its version at its time, one before it none", async ({
  page,
}) => {
  const seeded = seededState();
  const [change] = seeded.recentChanges;
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
  // A quarter into one hour and three quarters into another, on the clock browser and test share.
  const into = (hours: number, minutes: number) => {
    const at = new Date(Date.now() - hours * HOUR);
    at.setMinutes(minutes, 0, 0);
    return at.toISOString();
  };
  const marks = [
    { at: into(9, 45), version: "2.0.0", within: 0.75 },
    { at: into(5, 15), version: "2.1.0", within: 0.25 },
  ];
  const state: MockState = {
    ...seeded,
    recentChanges: [
      ...marks.map((mark) => deploy(mark.at, mark.version)),
      deploy(hoursAgo(30), "1.9.0"),
    ],
  };
  await mockDashboardApi(page, state);
  await page.goto("/");

  const strip = row(page, "verify-vault").locator(".hour-strip");
  await expect(strip.locator(".hour-mark")).toHaveText(["v2.0.0", "v2.1.0"]);
  for (const [index, { at, within }] of marks.entries()) {
    const mark = await strip.locator(".hour-mark").nth(index).boundingBox();
    const hour = await (await cellAt(page, strip, at)).boundingBox();
    if (mark === null || hour === null) throw new Error("Not drawn.");
    // The mark's centre stands as far into its hour's cell as the deploy came into the hour.
    expect(mark.x + mark.width / 2).toBeCloseTo(hour.x + within * hour.width, 0);
  }
});

test("automations with a failure come first, and a folder still narrows the list", async ({
  page,
}) => {
  const state = seededState();
  state.runs.push(runOf(state, "verify-ticker", hoursAgo(2), "failed"));
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
      // The row's 16 px inset on both sides.
      expect(strip.width).toBe(box.width - 32);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  });
});
