import { expect, test } from "@playwright/test";

import { APPROVAL_RUN_ID, mockDashboardApi, seededState } from "./dashboard-mock";

for (const overview of ["newest 200 approvals", "failed request"] as const) {
  for (const decision of ["Approve", "Reject"] as const) {
    test(`${decision} a selected approval when Overview has ${overview}`, async ({ page }) => {
      const state = seededState();
      const approval = state.needsYou.find((item) => item.kind === "approval");
      if (approval === undefined) throw new Error("Missing approval fixture");
      state.needsYou = Array.from({ length: 200 }, (_, index) => ({
        ...approval,
        runId: `newer-approval-${index}`,
      }));
      await mockDashboardApi(page, state);
      if (overview === "failed request") {
        await page.route("**/api/dashboard/overview?*", (route) =>
          route.fulfill({ status: 503, json: { message: "Overview unavailable" } }),
        );
      }

      await page.goto(`/runs?selected=${APPROVAL_RUN_ID}`);
      const panel = page.getByTestId("run-panel");
      await expect(panel.getByRole("button", { name: "Cancel run" })).toBeVisible();
      await expect(panel.getByRole("button", { name: decision, exact: true })).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
      await expect(
        page.getByTestId("run-row").filter({ hasText: APPROVAL_RUN_ID.slice(0, 8) }),
      ).toContainText("Waiting for approval");
      await panel.getByLabel("Comment").fill("Checked this older request");
      await panel.getByRole("button", { name: decision, exact: true }).click();
      await expect
        .poll(
          () =>
            state.requests.find(
              (request) => request.pathname === `/runs/${APPROVAL_RUN_ID}/approvals/gate`,
            )?.body,
        )
        .toEqual({ approved: decision === "Approve", comment: "Checked this older request" });
      await expect(panel.getByTestId("approval-card")).toHaveCount(0);
      await expect(panel.getByRole("heading", { name: "Queued", exact: true })).toBeVisible();
      await expect(
        page.getByTestId("run-row").filter({ hasText: APPROVAL_RUN_ID.slice(0, 8) }),
      ).toContainText("Queued");
    });
  }
}

test("Reassign hands an approval to a team, with the reason", async ({ page }) => {
  const state = seededState();
  await mockDashboardApi(page, state);

  await page.goto(`/runs?selected=${APPROVAL_RUN_ID}`);
  const card = page.getByTestId("run-panel").getByTestId("approval-card");
  await expect(card).toContainText("Assigned to anna@example.com");
  await card.getByRole("button", { name: "Reassign" }).click();
  // A team name may hold an "@"; the choice of Person or Team decides, not the name.
  await card.getByLabel("Person or team").selectOption("team");
  await card.getByLabel("Assign to").fill("Finance@EU");
  await card.getByLabel("Reason").fill("Anna is on leave");
  await card.getByRole("button", { name: "Reassign" }).click();

  await expect
    .poll(
      () =>
        state.requests.find(
          (request) => request.pathname === `/runs/${APPROVAL_RUN_ID}/approvals/gate/assignee`,
        )?.body,
    )
    .toEqual({ reason: "Anna is on leave", team: "Finance@EU" });
  await expect(card).toContainText("Assigned to the team Finance");
});
