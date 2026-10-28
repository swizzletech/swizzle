import { expect, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

// The first visit to a new instance creates its owner. A password the API would refuse keeps
// Create account disabled, and the password field says why.

test("the setup form says at the password field that 15 to 128 characters are needed", async ({
  page,
}) => {
  await mockDashboardApi(page, seededState(), { authenticated: false });
  await page.route(
    (url) => url.pathname === "/api/auth/status",
    (route) =>
      route.fulfill({
        json: { authenticated: false, mailConfigured: false, setupRequired: true, user: null },
      }),
  );
  await page.goto("/");
  await page.getByLabel("Name").fill("Owner");
  await page.getByLabel("Email").fill("owner@example.com");
  const password = page.getByLabel("Password");
  await password.fill("twelve-chars");

  await expect(page.getByRole("button", { name: "Create account" })).toBeDisabled();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toHaveAccessibleDescription(
    "12 characters. The password needs at least 15.",
  );

  await password.fill("x".repeat(129));
  await expect(page.getByRole("button", { name: "Create account" })).toBeDisabled();
  await expect(password).toHaveAccessibleDescription(
    "129 characters. The password can have at most 128.",
  );

  await password.fill("fifteen-chars-ok");
  await expect(password).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
});
