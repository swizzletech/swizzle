import { expect, type Page, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

// Without a mail server the link Settings › People shows is the only copy of an invitation, so
// neither the next invitation nor a failed request may take it off the page.

const OWNER = {
  createdAt: "2026-10-01T00:00:00.000Z",
  email: "ada@example.com",
  id: "person-1",
  name: "Ada",
  role: "owner",
  suspended: false,
  twoFactorEnabled: false,
} as const;
const LINK = "http://localhost/invitation#swzi_first-one-time-link";

/** An owner on an instance without mail; the first invitation succeeds, every later one fails. */
async function ownerWithoutMail(page: Page) {
  await mockDashboardApi(page, seededState());
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
  let sent = 0;
  await page.route(
    (url) => url.pathname === "/api/invitations",
    (route) => {
      if (route.request().method() !== "POST") return route.fulfill({ json: { invitations: [] } });
      sent += 1;
      if (sent > 1) {
        const error = "AUTH_ACCOUNT_EXISTS";
        const message = "bert@example.com already has an account here.";
        return route.fulfill({ json: { code: error, error, message }, status: 409 });
      }
      return route.fulfill({
        json: {
          createdAt: "2026-10-26T08:00:00.000Z",
          email: "anna@example.com",
          expiresAt: "2026-11-02T08:00:00.000Z",
          grants: [],
          id: "invitation-1",
          invitedBy: OWNER.id,
          mailed: false,
          role: "member",
          url: LINK,
        },
        status: 201,
      });
    },
  );
}

test("an invitation's link stays until Done, and a failed invitation shows no link", async ({
  page,
}) => {
  await ownerWithoutMail(page);
  await page.goto("/settings/people");
  const email = page.getByRole("textbox", { name: "Email", exact: true });
  const create = page.getByRole("button", { name: "Create link" });
  const link = page.getByLabel("Invitation link for anna@example.com");

  await email.fill("anna@example.com");
  await create.click();
  await expect(link).toHaveValue(LINK);

  await email.fill("bert@example.com");
  await expect(create).toBeDisabled();
  await expect(link).toHaveValue(LINK);

  await page.getByRole("button", { name: "Done" }).click();
  await expect(link).toHaveCount(0);
  await create.click();
  await expect(page.getByText("bert@example.com already has an account here.")).toBeVisible();
  await expect(page.getByTestId("invitation-link")).toHaveCount(0);
});

// The one-use token sits in the fragment; the page reads it once and takes it off the address bar.
test("an opened invitation link leaves no token in the address or the history", async ({
  page,
}) => {
  await mockDashboardApi(page, seededState(), { authenticated: false });
  await page.route(
    (url) => url.pathname === "/api/auth/invitation",
    (route) =>
      route.fulfill({
        json: {
          email: "anna@example.com",
          expiresAt: "2026-11-02T08:00:00.000Z",
          invitedBy: "Ada",
          projects: [],
          role: "member",
        },
      }),
  );
  await page.goto("/invitation#swzi_one-time-token");

  await expect(page.getByRole("heading", { name: "Join Swizzle" })).toBeVisible();
  await expect(page).toHaveURL(/\/invitation$/u);
  expect(await page.evaluate(() => window.location.href)).not.toContain("swzi_");
  // The history holds the blank tab and the invitation without its token, nothing else.
  expect(await page.evaluate(() => window.history.length)).toBe(2);
  await page.goBack();
  expect(page.url()).toBe("about:blank");
  await page.goForward();
  await expect(page).toHaveURL(/\/invitation$/u);
});
