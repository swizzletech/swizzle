import { expect, test } from "@playwright/test";

import { FAILED_RUN_ID, mockDashboardApi, OK_RUN_ID, seededState } from "./dashboard-mock";

const QUEUED_RUN_ID = "9d0e5f11-aaaa-4bbb-8ccc-000000000005";

test("a queued run that no worker has started says it has not started", async ({ page }) => {
  const state = seededState();
  const listed = state.runs.find((run) => run.runId === OK_RUN_ID);
  const detail = state.runDetails.get(OK_RUN_ID);
  if (listed === undefined || detail === undefined)
    throw new Error("The seeded state lost its succeeded run.");
  const notStarted = {
    attemptsMade: 0,
    finishedAt: null,
    runId: QUEUED_RUN_ID,
    startedAt: null,
    status: "queued" as const,
  };
  state.runs.unshift({ ...listed, ...notStarted });
  state.runDetails.set(QUEUED_RUN_ID, { ...detail, ...notStarted, result: null });
  await mockDashboardApi(page, state);

  await page.goto(`/runs?selected=${QUEUED_RUN_ID}`);

  const panel = page.getByTestId("run-panel");
  await expect(panel.getByRole("heading", { name: "Queued" })).toBeVisible();
  await expect(panel.locator(".facts > div", { hasText: "Duration" }).locator("b")).toHaveText(
    "Not started",
  );
});

test("at phone width a long unbroken error, payload or log stays inside the run panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = seededState();
  const detail = state.runDetails.get(FAILED_RUN_ID);
  if (detail === undefined) throw new Error("The seeded state lost its failed run.");
  const unbroken = "x".repeat(600);
  state.runDetails.set(FAILED_RUN_ID, {
    ...detail,
    errorMessage: unbroken,
    payload: { blob: unbroken },
    stderr: `${unbroken}\n`,
  });
  await mockDashboardApi(page, state);

  await page.goto(`/runs?selected=${FAILED_RUN_ID}`);

  const panel = page.getByTestId("run-panel");
  for (const tab of ["Error", "Payload", "Logs"]) {
    await panel.getByRole("tab", { name: tab }).click();
    const widths = await panel.evaluate((element) => ({
      content: element.scrollWidth,
      panel: element.clientWidth,
    }));
    expect(widths.content, tab).toBe(widths.panel);
  }
});

// Runs and an automation's Runs tab both list runs beside the chosen one; a phone has no beside.
for (const { page: name, path, parameter } of [
  { page: "Runs", parameter: "selected", path: "/runs" },
  { page: "an automation's Runs tab", parameter: "run", path: "/automations/verify-probe" },
]) {
  test(`at phone width a run opened on ${name} from a link or a tapped row shows at once`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = seededState();
    const listed = state.runs.find((run) => run.runId === OK_RUN_ID);
    const detail = state.runDetails.get(OK_RUN_ID);
    if (listed === undefined || detail === undefined)
      throw new Error("The seeded state lost its succeeded run.");
    // A full page of runs, as the CLI's dashboardUrl opens it.
    for (let index = 0; index < 60; index += 1) {
      const runId = `9d0e5f11-aaaa-4bbb-8ccc-${String(index).padStart(12, "0")}`;
      state.runs.push({ ...listed, runId });
      state.runDetails.set(runId, { ...detail, runId });
    }
    await mockDashboardApi(page, state);

    await page.goto(`${path}?${parameter}=${FAILED_RUN_ID}`);
    const panel = page.getByTestId("run-panel");
    await expect(panel.getByRole("heading", { name: "Failed after 2 attempts" })).toBeInViewport();

    await page.getByRole("button", { name: "All runs" }).click();
    const row = page.getByTestId("run-row").nth(20);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`${parameter}=9d0e5f11`, "u"));
    await expect(panel.getByRole("heading", { name: "Succeeded" })).toBeInViewport();
  });
}

test("a failure the diagnosis cannot add to reads once, with its next step", async ({ page }) => {
  const state = seededState();
  const detail = state.runDetails.get(FAILED_RUN_ID);
  if (detail === undefined) throw new Error("The seeded state lost its failed run.");
  const message =
    "No person with the email nobody@example.com has an account here, so nobody could decide the approval gate.";
  const fix =
    "Invite that person under Settings › People, or name an assignee who has an account here, then run the automation again.";
  state.runDetails.set(FAILED_RUN_ID, {
    ...detail,
    errorCode: "APPROVAL_ASSIGNEE_NOT_FOUND",
    errorMessage: message,
  });
  await mockDashboardApi(page, state);
  await page.route(
    (url) => url.pathname === `/api/runs/${FAILED_RUN_ID}/diagnosis`,
    (route) =>
      route.fulfill({
        json: {
          likelyCause: { code: "APPROVAL_ASSIGNEE_NOT_FOUND", summary: message },
          suggestedFixes: [{ confidence: 0.9, rationale: fix }],
        },
      }),
  );

  await page.goto(`/runs?selected=${FAILED_RUN_ID}`);

  const error = page.getByTestId("run-error");
  await expect(error.getByText(fix)).toBeVisible();
  await expect(error.getByText(message)).toHaveCount(1);
});
