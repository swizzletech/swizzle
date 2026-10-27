import { expect, type Page, test } from "@playwright/test";

import { type MockTwoFactor, mockDashboardApi, seededState } from "./dashboard-mock";

const TWO_FACTOR = { recoveryCode: "abcde-12345", totp: "123456" } as const;

async function enterPassword(page: Page) {
  await page.getByLabel("Email").fill("person@example.com");
  await page.getByLabel("Password").fill("a-long-person-password");
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function openSignIn(page: Page, twoFactor: MockTwoFactor) {
  const state = seededState();
  await mockDashboardApi(page, state, { authenticated: false, twoFactor });
  await page.goto("/");
  await enterPassword(page);
  return state;
}

test("the password alone asks for the code, and the code signs in", async ({ page }) => {
  const state = await openSignIn(page, TWO_FACTOR);
  const code = page.getByLabel("Authentication code");
  await expect(code).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Dashboard" })).toHaveCount(0);

  await code.fill("654321");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByText("That code is incorrect, expired or already used. Try the current one."),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Dashboard" })).toHaveCount(0);

  await code.fill(TWO_FACTOR.totp);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("navigation", { name: "Dashboard" })).toBeVisible();
  expect(
    state.requests.filter((request) => request.pathname.startsWith("/auth/two-factor/")),
  ).toMatchObject([
    { body: { code: "654321" }, pathname: "/auth/two-factor/verify-totp" },
    { body: { code: TWO_FACTOR.totp }, pathname: "/auth/two-factor/verify-totp" },
  ]);
});

test("a recovery code goes to the recovery-code check and signs in", async ({ page }) => {
  const state = await openSignIn(page, TWO_FACTOR);

  await page.getByLabel("Authentication code").fill(TWO_FACTOR.recoveryCode);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("navigation", { name: "Dashboard" })).toBeVisible();
  expect(state.requests.map((request) => request.pathname)).toContain(
    "/auth/two-factor/verify-backup-code",
  );
});

test("an expired challenge returns to the password step", async ({ page }) => {
  await openSignIn(page, { ...TWO_FACTOR, expireFirstChallenge: true });

  await page.getByLabel("Authentication code").fill(TWO_FACTOR.totp);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByText("The sign-in took too long. Enter your password again."),
  ).toBeVisible();
  await expect(page.getByLabel("Authentication code")).toHaveCount(0);
  await enterPassword(page);
  await page.getByLabel("Authentication code").fill(TWO_FACTOR.totp);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("navigation", { name: "Dashboard" })).toBeVisible();
});
