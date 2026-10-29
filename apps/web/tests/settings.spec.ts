import { expect, type Page, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

// Settings as each instance role sees it: one page per section, the nav that reaches each one, the
// signed-in browsers and the workers.

const OWNER = {
  createdAt: "2026-10-01T00:00:00.000Z",
  email: "owner@example.com",
  id: "owner-1",
  name: "Owner",
  role: "owner",
  suspended: false,
  twoFactorEnabled: false,
} as const;

async function asOwner(page: Page, state = seededState()) {
  await mockDashboardApi(page, state);
  await page.route(
    (url) => url.pathname === "/api/auth/status",
    (route) =>
      route.fulfill({
        json: { authenticated: true, mailConfigured: false, setupRequired: false, user: OWNER },
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/users",
    (route) => route.fulfill({ json: { users: [OWNER] } }),
  );
  await page.route(
    (url) => url.pathname === "/api/invitations",
    (route) => route.fulfill({ json: { invitations: [] } }),
  );
  await page.route(
    (url) => url.pathname === "/api/teams",
    (route) => route.fulfill({ json: { teams: [] } }),
  );
  await page.route(
    (url) => url.pathname === "/api/workers",
    (route) => route.fulfill({ json: { workers: [] } }),
  );
}

const OWNER_SECTIONS = [
  ["Agent access", "/settings/agent-access"],
  ["Notifications", "/settings/notifications"],
  ["Account", "/settings/account"],
  ["Two-factor sign-in", "/settings/two-factor"],
  ["People", "/settings/people"],
  ["Teams", "/settings/teams"],
  ["Workers", "/settings/workers"],
  ["Status", "/settings/status"],
] as const;

test("the sidebar's Settings opens Agent access, and the nav opens every section", async ({
  page,
}) => {
  await asOwner(page);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page).toHaveURL(/\/settings\/agent-access$/u);

  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.locator(".snav-label")).toHaveText(["You", "Instance"]);
  await expect(nav.getByRole("link")).toHaveText(OWNER_SECTIONS.map(([label]) => label));
  for (const [label, path] of OWNER_SECTIONS) {
    await nav.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`, "u"));
    await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
    await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  }
});

test("a member sees only their own sections, and an instance section's address opens Agent access", async ({
  page,
}) => {
  // The mock's person is a member.
  await mockDashboardApi(page, seededState());
  await page.goto("/settings/status");

  await expect(page).toHaveURL(/\/settings\/agent-access$/u);
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.getByRole("link")).toHaveText([
    "Agent access",
    "Notifications",
    "Account",
    "Two-factor sign-in",
  ]);
  await expect(nav.locator(".snav-label")).toHaveText(["You"]);
  await expect(nav).toContainText("Swizzle 0.9.0");
  await expect(page.getByText("owners and admins")).toHaveCount(0);
});

for (const path of ["/projects", "/no-such-page"]) {
  test(`at phone width ${path} shows no empty band in the header`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockDashboardApi(page, seededState());
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();

    // The space between the header's last row and its bottom edge: its padding, not a band.
    const band = await page
      .locator("aside.side")
      .evaluate(
        (side) =>
          side.getBoundingClientRect().bottom -
          Math.max(...[...side.children].map((row) => row.getBoundingClientRect().bottom)),
      );
    expect(band).toBeLessThan(16);
  });
}

test("at phone width the section nav shows every section", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await asOwner(page);
  await page.goto("/settings");

  const links = page.getByRole("navigation", { name: "Settings" }).getByRole("link");
  await expect(links).toHaveCount(8);
  for (const link of await links.all()) await expect(link).toBeInViewport({ ratio: 1 });
});

test("each signed-in session names its browser and device", async ({ page }) => {
  await asOwner(page);
  const session = {
    createdAt: "2026-10-26T08:00:00.000Z",
    expiresAt: "2026-11-26T08:00:00.000Z",
    lastSeenAt: "2026-10-26T09:00:00.000Z",
  };
  await page.route(
    (url) => url.pathname === "/api/auth/sessions",
    (route) =>
      route.fulfill({
        json: {
          sessions: [
            {
              ...session,
              current: true,
              id: "session-mac",
              userAgent:
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
            },
            {
              ...session,
              current: false,
              id: "session-phone",
              userAgent:
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
            },
            { ...session, current: false, id: "session-script", userAgent: null },
          ],
        },
      }),
  );
  await page.goto("/settings/account");

  const sessions = page.getByTestId("session");
  await expect(sessions.nth(0)).toContainText("Chrome on Mac");
  await expect(sessions.nth(1)).toContainText("Safari on iPhone");
  await expect(sessions.nth(2)).toContainText("Unknown browser");
  await expect(page.getByRole("button", { name: "Sign out Safari on iPhone" })).toBeVisible();
});

test("a revoked worker shows no slots in use", async ({ page }) => {
  await asOwner(page);
  const worker = {
    capabilities: null,
    capacity: 1,
    createdAt: "2026-10-20T08:00:00.000Z",
    credentialGeneration: 1,
    currentRuns: [],
    draining: false,
    environments: "all",
    kind: "remote",
    lastSeenAt: "2026-10-25T08:00:00.000Z",
    localLlm: null,
    profiles: ["office"],
    runImageDisk: null,
    runImageDiskOverBudget: null,
    runImageDiskWarning: null,
    services: [],
    slotsInUse: 0,
    tokenExpiresAt: null,
  };
  await page.route(
    (url) => url.pathname === "/api/workers",
    (route) =>
      route.fulfill({
        json: {
          workers: [
            { ...worker, id: "worker-live", name: "Office PC", state: "online" },
            { ...worker, id: "worker-gone", name: "Old laptop", state: "revoked" },
          ],
        },
      }),
  );
  await page.goto("/settings/workers");

  const cards = page.getByTestId("worker");
  await expect(cards.nth(0)).toContainText("Idle · 0 of 1 slot in use");
  await expect(cards.nth(1)).toContainText("Revoked");
  await expect(cards.nth(1)).not.toContainText("slot");
});
