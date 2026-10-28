import { expect, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

// Any agent token can deploy a bundle, so its README is hostile input. Markup that survives the
// sanitizer stays inside the README box and cannot dress itself as dashboard UI.

const HOSTILE_README = `# Hostile README

<div id="overlay" style="position:fixed;inset:0;z-index:2147483647;background:#fff">
<h2>Your session expired</h2>
<a href="https://attacker.example/swizzle-login">Sign in to Swizzle</a>
</div>

<a class="btn fixed inset-0" href="https://attacker.example/button">Looks like a dashboard button</a>
`;

test("a README cannot draw outside its box or reuse dashboard classes", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.route(
    (url) => url.pathname === "/api/dashboard/automations/verify-probe/readme",
    (route) =>
      route.fulfill({
        body: JSON.stringify({
          automationSlug: "verify-probe",
          available: true,
          content: HOSTILE_README,
          environment: "staging",
          error: null,
          filePath: "README.md",
        }),
        contentType: "application/json",
      }),
  );
  await page.goto("/automations/verify-probe?tab=about");

  const readme = page.getByTestId("automation-readme");
  await expect(readme.getByRole("heading", { name: "Your session expired" })).toBeVisible();
  // Every element the README drew, as far as it reaches on screen, stays inside the article.
  const escaped = await readme.evaluate((article) => {
    const box = article.getBoundingClientRect();
    return Array.from(article.querySelectorAll("*"), (element) => {
      const rect = element.getBoundingClientRect();
      const inside =
        rect.left >= box.left &&
        rect.top >= box.top &&
        rect.right <= box.right &&
        rect.bottom <= box.bottom;
      return inside
        ? null
        : `${element.tagName} ${rect.left},${rect.top},${rect.width}x${rect.height}`;
    }).filter((entry) => entry !== null);
  });
  expect(escaped).toEqual([]);
  await expect(readme.locator("[style], [class], [id]")).toHaveCount(0);

  // The box itself holds whatever gets past the sanitizer: a fixed overlay placed straight into
  // the article neither paints nor takes clicks outside it.
  await readme.evaluate((article) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#fff";
    article.append(overlay);
  });
  // Playwright clicks only an element that receives the pointer, so this fails under an overlay.
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Runs" })
    .click();
  await expect(page).toHaveURL(/\/runs$/u);
});
