import { expect, type Page, test } from "@playwright/test";

import { mockDashboardApi, OK_RUN_ID, seededState } from "./dashboard-mock";

const CANCELLED_RUN_ID = "9d2f7a10-aaaa-4bbb-8ccc-000000000009";

/** The seeded instance, plus a run a person cancelled as verify-probe's latest. */
async function seeded(page: Page, path: string) {
  const state = seededState();
  const ok = state.runs.find((run) => run.runId === OK_RUN_ID);
  const probe = state.automations.find((item) => item.automationSlug === "verify-probe");
  if (ok === undefined || probe?.recentRuns[0] === undefined) throw new Error("Seed changed.");
  const cancelled = {
    deadLetterReason: "user-cancelled",
    runId: CANCELLED_RUN_ID,
    state: "cancelled",
    status: "dead-lettered",
  } as const;
  state.runs.push({ ...ok, ...cancelled });
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
  await mockDashboardApi(page, state);
  await page.goto(path);
}

test("the Overview counts a cancelled run in Runs alone and draws it neutral", async ({ page }) => {
  await seeded(page, "/");
  const stats = page.getByTestId("status-card");
  await expect(stats.locator(".stats > div", { hasText: "Failed" })).toContainText("1");
  await expect(stats.locator(".stats > div", { hasText: "Runs" })).toContainText("5");

  // Every hour that names the cancelled run names it apart from the one failure, which alone
  // draws an hour full.
  const strip = page.getByTestId("automation-row").first().locator(".hour-cells");
  await expect(strip.locator("i.full")).toHaveCount(1);
  await expect(strip.locator("i.full")).toHaveAttribute("data-tip", /1 failed/u);
  await expect(strip.locator('i[data-tip*="1 cancelled"]')).toHaveCount(1);
});

test("Failed leaves a cancelled run out and All keeps it, labelled", async ({ page }) => {
  await seeded(page, "/runs?status=failed");
  await expect(page.getByTestId("run-row")).toHaveCount(1);
  await expect(page.getByTestId("run-list-pane")).not.toContainText("Cancelled");

  await page.getByRole("tab", { name: "All" }).click();
  await expect(page.getByTestId("run-list-pane")).toContainText("Cancelled");
});
