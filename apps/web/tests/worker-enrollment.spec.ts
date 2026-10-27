import { expect, test } from "@playwright/test";
import { mockDashboardApi, PROJECT_ID, seededState } from "./dashboard-mock";

for (const delayed of [false, true]) {
  test(`an enrollment ${delayed ? "arriving after" : "shown before"} an environment switch cannot appear in the new scope`, async ({
    page,
  }) => {
    await mockDashboardApi(page, seededState());
    await page.route(
      (url) => url.pathname === "/api/auth/status",
      (route) =>
        route.fulfill({
          json: {
            authenticated: true,
            setupRequired: false,
            user: {
              id: "owner",
              name: "Owner",
              email: "owner@example.test",
              role: "owner",
              twoFactorEnabled: false,
            },
          },
        }),
    );
    await page.route("**/api/workers", (route) => route.fulfill({ json: { workers: [] } }));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/workers/enrollments", async (route) => {
      if (delayed) await gate;
      await route.fulfill({
        json: {
          worker: {
            id: "worker-1",
            name: "Staging laptop",
            profiles: ["macbook"],
            services: [],
            environments: [{ projectId: PROJECT_ID, environment: "staging" }],
          },
          code: "staging-enrollment-only",
          expiresAt: "2027-01-01T00:00:00Z",
        },
      });
    });
    await page.goto("/settings#workers");
    const workers = page.locator("#workers");
    await workers.getByLabel("Worker name", { exact: true }).fill("Staging laptop");
    await workers.getByLabel("Groups (comma-separated)").fill("macbook");
    await workers.getByRole("combobox", { name: "Project", exact: true }).selectOption(PROJECT_ID);
    const request = page.waitForRequest("**/api/workers/enrollments");
    await workers.getByRole("button", { name: "Create enrollment code" }).click();
    expect((await request).postDataJSON().environments).toEqual([
      { projectId: PROJECT_ID, environment: "staging" },
    ]);
    if (!delayed)
      await expect(workers.getByText("staging-enrollment-only", { exact: true })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Environment", exact: true })
      .selectOption("production");
    await expect(workers).toContainText("approve groups and a project in production below.");
    if (delayed) {
      const response = page.waitForResponse("**/api/workers/enrollments");
      release();
      await response;
    }
    await expect(workers.getByLabel("Worker name", { exact: true })).toHaveValue("");
    await expect(workers.getByLabel("Groups (comma-separated)")).toHaveValue("");
    await expect(workers.getByRole("combobox", { name: "Project", exact: true })).toHaveValue("");
    await expect(workers.getByText("staging-enrollment-only", { exact: true })).toHaveCount(0);
    await expect(workers.getByRole("button", { name: "Dismiss code" })).toHaveCount(0);
  });
}
