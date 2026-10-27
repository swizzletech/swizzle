import { expect, test } from "@playwright/test";

import {
  APPROVAL_RUN_ID,
  FAILED_RUN_ID,
  mockDashboardApi,
  PROJECT_ID,
  seededState,
} from "./dashboard-mock";

// Right after sign-in the Overview lists what needs the owner, and each row acts where it stands:
// approve a waiting run, store a missing secret, hand a failing automation to an agent.

test("signing in lands on Needs you, whose rows act inline", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const state = seededState();
  await mockDashboardApi(page, state, { authenticated: false });

  await page.goto("/");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("a-long-owner-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  const needsYou = page.getByTestId("needs-you");
  await expect(page.getByRole("heading", { name: "3 things need you." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Overview 3" })).toBeVisible();

  // Needs you lists the approvals the viewer decides; Approve sends the verdict and comment.
  const approval = needsYou.locator('[data-kind="approval"]');
  await expect(approval).toContainText("verify-probe asks: gate");
  await expect(approval).toContainText("Refund 120 € for order 4411?");
  await approval.getByLabel("Comment").fill("Customer is right");
  await approval.getByRole("button", { name: "Approve" }).click();
  await expect(approval).toHaveCount(0);
  expect(
    state.requests.find((request) => request.pathname === `/runs/${APPROVAL_RUN_ID}/approvals/gate`)
      ?.body,
  ).toEqual({ approved: true, comment: "Customer is right" });

  // A missing secret is stored from its row; the value goes to the API and is never shown. The
  // deployment binds secrets at publish, so the row then asks for a deploy instead.
  const blocked = needsYou.locator('[data-kind="missing-secret"]');
  await blocked.getByLabel("Value of VERIFY_SECRET").fill("s3cret-value");
  await blocked.getByRole("button", { name: "Save" }).click();
  await expect(blocked).toContainText("Deploy it again to use the one set now.");
  await expect(blocked.getByRole("button", { name: "Save" })).toHaveCount(0);
  const saved = state.requests.find(
    (request) => request.method === "PUT" && request.pathname === "/secrets/VERIFY_SECRET",
  );
  expect(saved?.body).toEqual({ value: "s3cret-value" });
  expect(saved?.search.get("overwrite")).toBe("false");
  expect(saved?.search.get("project")).toBe(PROJECT_ID);
  await expect(page.getByText("s3cret-value")).toHaveCount(0);

  // Hand to agent copies the situation and the commands to investigate with.
  await needsYou
    .locator('[data-kind="failing"]')
    .getByRole("button", { name: "Hand to agent" })
    .click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  const handoff = await page.evaluate(() => navigator.clipboard.readText());
  expect(handoff).toBe(
    `verify-probe is failing: 1 of its last 3 runs failed. The latest failed run is ${FAILED_RUN_ID}: ` +
      "Automation exited with code 1. " +
      `Investigate with \`swizzle diagnose ${FAILED_RUN_ID}\` and \`swizzle logs --run ${FAILED_RUN_ID}\`, ` +
      "fix the cause and redeploy.",
  );

  await expect(page.getByRole("heading", { name: "2 things need you." })).toBeVisible();
  expect(state.unhandled).toEqual([]);
});

// Plain HTTP has no clipboard, and a browser may refuse it; the handoff text must still reach an agent.
test("Hand to agent without a clipboard shows the text to copy by hand", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined });
  });
  await mockDashboardApi(page, seededState());

  await page.goto("/");
  await page
    .getByTestId("needs-you")
    .locator('[data-kind="failing"]')
    .getByRole("button", { name: "Hand to agent" })
    .click();

  const text = page.getByRole("textbox", { name: "Hand to agent: copy this text" });
  await expect(text).toBeFocused();
  await expect(text).toHaveValue(/^verify-probe is failing: .* fix the cause and redeploy\.$/u);
});

test("View opens the failed run on its error, with the cause in words", async ({ page }) => {
  const state = seededState();
  await mockDashboardApi(page, state);

  await page.goto("/");
  await page
    .getByTestId("needs-you")
    .locator('[data-kind="failing"]')
    .getByRole("link", { name: "View" })
    .click();

  await expect(page).toHaveURL(
    new RegExp(`/automations/verify-probe\\?run=${FAILED_RUN_ID}$`, "u"),
  );
  const panel = page.getByTestId("run-panel");
  await expect(panel.getByRole("heading", { name: "Failed after 2 attempts" })).toBeVisible();
  await expect(panel.getByTestId("run-error")).toContainText("Inspect stderr for the root cause.");
  await expect(panel.getByRole("tab", { name: "Error" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".screen")).toContainText("TypeError: Cannot read properties");
  expect(state.unhandled).toEqual([]);
});
