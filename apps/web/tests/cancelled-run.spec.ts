import { expect, type Page, test } from "@playwright/test";

import {
  allRunPage,
  mockDashboardApi,
  OK_RUN_ID,
  seededState,
  setAllRunPage,
  withRunOutcome,
} from "./dashboard-mock";

const CANCELLED_RUN_ID = "9d2f7a10-aaaa-4bbb-8ccc-000000000009";

async function seeded(page: Page, path: string, deadLetterReason: string) {
  const state = seededState();
  const { runs } = allRunPage(state);
  const ok = runs.find((run) => run.runId === OK_RUN_ID);
  const probe = state.automations.find((item) => item.automationSlug === "verify-probe");
  if (ok === undefined || probe?.recentRuns[0] === undefined) throw new Error("Seed changed.");
  const cancelled = {
    ...ok,
    deadLetterReason,
    runId: CANCELLED_RUN_ID,
    state: "cancelled",
    status: "dead-lettered",
  } as const;
  setAllRunPage(state, [...runs, cancelled]);
  state.automations = state.automations.map((item) =>
    item === probe
      ? {
          ...item,
          recentRuns: [
            {
              ...probe.recentRuns[0],
              runId: CANCELLED_RUN_ID,
              state: "cancelled",
              status: "dead-lettered",
            } as (typeof item.recentRuns)[number],
            ...item.recentRuns,
          ],
        }
      : item,
  );
  state.overview = withRunOutcome(state.overview, cancelled);
  await mockDashboardApi(page, state);
  await page.goto(path);
}

test("the Overview counts a cancelled run in Runs alone and draws it neutral", async ({ page }) => {
  await seeded(page, "/", "user-cancelled");
  const stats = page.getByTestId("status-card");
  await expect(stats.locator(".stats > div", { hasText: "Failed" })).toContainText("1");
  await expect(stats.locator(".stats > div", { hasText: "Runs" })).toContainText("5");

  const strip = page.getByTestId("automation-row").first().locator(".hour-cells");
  await expect(strip.locator("i.full")).toHaveCount(1);
  await expect(strip.locator("i.full")).toHaveAttribute("data-tip", /1 failed/u);
  await expect(strip.locator('i[data-tip*="1 cancelled"]')).toHaveCount(1);
});

test("Failed leaves a cancelled run out and All keeps it, labelled", async ({ page }) => {
  const request = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname.endsWith("/dashboard/runs");
  });
  await seeded(page, "/runs?status=failed", "parent-cancelled");
  const query = new URL((await request).url()).searchParams;
  expect(query.get("state")).toBe("failed,dead-lettered");
  expect(query.has("status")).toBe(false);
  await expect(page.getByTestId("run-row")).toHaveCount(1);
  await expect(page.getByTestId("run-list-pane")).not.toContainText("Cancelled");

  await page.getByRole("tab", { name: "All" }).click();
  await expect(page.getByTestId("run-list-pane")).toContainText("Cancelled");
});
