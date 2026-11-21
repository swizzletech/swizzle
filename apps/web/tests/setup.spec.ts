import { expect, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

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

test("a throttled first status check waits before opening the signed-in dashboard", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-21T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-21T12:01:00Z"));
  const state = seededState();
  await mockDashboardApi(page, state);
  let throttledRequests = 0;
  await page.route(
    (url) => url.pathname === "/api/auth/status",
    async (route) => {
      throttledRequests += 1;
      await route.fulfill({
        status: 429,
        headers: { "Retry-After": "5" },
        json: { error: "AUTH_RATE_LIMITED" },
      });
    },
    { times: 2 },
  );

  await page.goto("/");
  const waiting = page.getByRole("status", { name: "Waiting to check sign-in" });
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return waiting.isVisible();
    })
    .toBe(true);
  await page.clock.runFor(4_000);
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  expect(throttledRequests).toBe(1);
  expect(state.requests.filter(({ pathname }) => pathname === "/auth/status")).toHaveLength(0);

  await page.clock.resume();
  await expect(page.getByRole("navigation", { name: "Dashboard" })).toBeVisible();
  expect(throttledRequests).toBe(2);
});

test("a throttled status refresh keeps the dashboard until the session check succeeds", async ({
  page,
}) => {
  await page.clock.install();
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto("/");
  const dashboard = page.getByRole("navigation", { name: "Dashboard" });
  await expect(dashboard).toBeVisible();
  await page.route(
    (url) => url.pathname === "/api/auth/status",
    (route) =>
      route.fulfill({
        status: 429,
        headers: { "Retry-After": "1" },
        json: { error: "AUTH_RATE_LIMITED" },
      }),
    { times: 1 },
  );
  const throttled = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/status" && response.status() === 429,
  );
  const retried = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/status" && response.status() === 200,
  );
  await page.clock.fastForward(60_000);
  await throttled;
  await expect(dashboard).toBeVisible();
  await retried;
  await expect(dashboard).toBeVisible();
});
