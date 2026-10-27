import { expect, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

// A mailed link opened in a tab that already shows that page changes only the fragment, so the
// page must read the new token without a reload.

test("a second invitation link opened in the same tab shows its invitation", async ({ page }) => {
  await mockDashboardApi(page, seededState(), { authenticated: false });
  await page.route(
    (url) => url.pathname === "/api/auth/invitation",
    (route) => {
      const { token } = route.request().postDataJSON() as { token: string };
      if (token !== "swzi_second") {
        const error = "AUTH_INVITATION_INVALID";
        const message = "This invitation is used or expired.";
        return route.fulfill({ json: { code: error, error, message }, status: 400 });
      }
      return route.fulfill({
        json: {
          email: "bert@example.com",
          expiresAt: "2026-11-02T08:00:00.000Z",
          invitedBy: "Ada",
          projects: [],
          role: "member",
        },
      });
    },
  );

  await page.goto("/invitation#swzi_first");
  await expect(page.getByRole("heading", { name: "This invitation does not work" })).toBeVisible();

  await page.goto("/invitation#swzi_second");
  await expect(page.getByRole("heading", { name: "Join Swizzle" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("bert@example.com");
  await expect(page).toHaveURL(/\/invitation$/u);
});

test("a second reset link opened in the same tab sets the password with its token", async ({
  page,
}) => {
  await mockDashboardApi(page, seededState(), { authenticated: false });
  const resetTokens: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/auth/reset-password",
    (route) => {
      resetTokens.push((route.request().postDataJSON() as { token: string }).token);
      return route.fulfill({ json: { status: true } });
    },
  );
  const setPassword = async () => {
    await page.getByLabel("New password").first().fill("a-new-password-of-length");
    await page.getByLabel("New password again").fill("a-new-password-of-length");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeVisible();
  };

  await page.goto("/reset-password#swzr_first");
  await setPassword();

  await page.goto("/reset-password#swzr_second");
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  await setPassword();
  expect(resetTokens).toEqual(["swzr_first", "swzr_second"]);
});
