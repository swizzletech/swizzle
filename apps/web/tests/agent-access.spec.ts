import { expect, test } from "@playwright/test";

import type { Project, ProjectAccess } from "../src/lib/api";
import { mockDashboardApi, PROJECT_ID, seededState } from "./dashboard-mock";

// Settings promises the agent token is shown only once. The browser keeps a page it leaves in the
// back/forward cache, so Back must not bring the token block back.

// Playwright turns the back/forward cache off, and its headless shell has none; this flow needs
// the cache of the full browser.
test.use({
  channel: "chromium",
  launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] },
});

test("the one-time agent token is gone after leaving the page and pressing Back", async ({
  page,
}) => {
  // Records what the cached page holds the moment it comes back, before React could render.
  await page.addInitScript(() => {
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      const token = document.querySelector('[data-testid="give-to-agent"]') !== null;
      document.documentElement.dataset.restored = token ? "with-token" : "without-token";
    });
  });
  await mockDashboardApi(page, seededState());
  await page.goto("/settings/agent-access");
  await page.getByLabel("Token name").fill("Claude on my laptop");
  await page.getByRole("button", { name: "Create agent token" }).click();
  await expect(page.getByTestId("give-to-agent")).toContainText("swz_token-1_one-time-plaintext");

  await page.goto("about:blank");
  // A page restored from the cache fires no load event, so wait only for the navigation.
  await page.goBack({ waitUntil: "commit" });

  // Without the attribute the page loaded fresh, which remounts React and proves nothing.
  await expect(page.locator("html")).toHaveAttribute("data-restored", "without-token");
  await expect(page.getByRole("heading", { name: "Agent access" })).toBeVisible();
  await expect(page.getByText("swz_token-1_one-time-plaintext")).toHaveCount(0);
});

// The owner may leave while the token is still being created. The answer then arrives in the
// cached page, and Back must not show it either.
test("a token that arrives after the owner left is not shown on Back", async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) document.documentElement.dataset.restored = "true";
    });
  });
  await mockDashboardApi(page, seededState());
  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/auth/tokens",
    async (route) => {
      if (route.request().method() === "POST") await answered;
      await route.fallback();
    },
  );
  await page.goto("/settings/agent-access");
  await page.getByLabel("Token name").fill("Claude on my laptop");
  await page.getByRole("button", { name: "Create agent token" }).click();
  await expect(page.getByRole("button", { name: "Creating…" })).toBeVisible();

  await page.goto("about:blank");
  answer();
  await page.goBack({ waitUntil: "commit" });

  await expect(page.locator("html")).toHaveAttribute("data-restored", "true");
  // The new token's row shows once the creation has finished in the restored page.
  await expect(page.getByTestId("token-row")).toContainText("Claude on my laptop");
  await expect(page.getByTestId("give-to-agent")).toHaveCount(0);
  await expect(page.getByText("swz_token-1_one-time-plaintext")).toHaveCount(0);
});

test("a limited agent token is sent with its limits and listed with them", async ({ page }) => {
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto("/settings/agent-access");
  await page.getByLabel("Token name").fill("Claude for Default");
  await page.getByText("Limit what it may do").click();
  const scope = page.getByTestId("scope-fields");
  await scope.getByRole("combobox", { name: "At most" }).selectOption("operator");
  await scope.getByRole("checkbox", { exact: true, name: "Default" }).check();
  await scope.getByRole("checkbox", { exact: true, name: "staging" }).check();
  await page.getByRole("button", { name: "Create agent token" }).click();

  await expect(page.getByTestId("token-row")).toContainText("at most operator · Default · staging");
  const created = state.requests.find(
    (request) => request.method === "POST" && request.pathname === "/auth/tokens",
  );
  expect(created?.body).toMatchObject({
    scope: { environments: ["staging"], projects: ["default"], role: "operator" },
  });
});

// A browser or an agent's webview may suppress window.confirm and answer false at once. Revoking
// must still work, so the dashboard asks in the page.
test("revoking an agent token asks in the page, even where window.confirm answers false", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.confirm = () => false;
  });
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto("/settings/agent-access");
  await page.getByLabel("Token name").fill("Claude on my laptop");
  await page.getByRole("button", { name: "Create agent token" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByTestId("token-row").getByRole("button", { name: "Revoke" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Revoke Claude on my laptop?");
  await dialog.getByRole("button", { name: "Revoke" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("token-row")).toHaveCount(0);
  expect(
    state.requests.filter(
      (request) => request.method === "DELETE" && request.pathname === "/auth/tokens/token-1",
    ),
  ).toHaveLength(1);
});

// The block shows only once, so copying it must end in a visible outcome even when the browser
// refuses the clipboard or never answers.
for (const refusal of ["rejects", "never answers"] as const) {
  test(`Copy block selects the block for copying by hand when the clipboard ${refusal}`, async ({
    page,
  }) => {
    await page.addInitScript((mode) => {
      const writeText =
        mode === "rejects"
          ? () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"))
          : () => new Promise<void>(() => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText } });
    }, refusal);
    const silent = refusal === "never answers";
    if (silent) await page.clock.install();
    await mockDashboardApi(page, seededState());
    await page.goto("/settings/agent-access");
    await page.getByLabel("Token name").fill("Claude on my laptop");
    await page.getByRole("button", { name: "Create agent token" }).click();
    const block = page.getByTestId("give-to-agent");
    const copy = block.getByRole("button", { name: "Copy block" });
    // A silent clipboard ends at the button's 1.5 s deadline: time stands until the test runs it.
    if (silent) await page.clock.pauseAt(Date.now() + 60_000);
    await copy.click();
    if (silent) {
      // While the clipboard is asked, a second attempt cannot start and race the first.
      await expect(copy).toBeDisabled();
      await page.clock.runFor(1_500);
    }

    await expect(block.getByRole("alert")).toContainText("press Ctrl+C or ⌘C");
    await expect
      .poll(() => page.evaluate(() => String(window.getSelection())))
      .toMatch(
        /^export SWIZZLE_TOKEN='swz_token-1_one-time-plaintext'\n.*swizzle workspace init/su,
      );
  });
}

// Agent access is the one place to connect an agent: it names the service account as the other
// identity and links to it, and the project's Service accounts tab links back.
test("Agent access and a project's Service accounts tab lead to each other", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  const access: ProjectAccess = {
    automationSlugs: {},
    environments: ["staging", "production"],
    grants: [],
    holders: [],
    project: {
      createdAt: "2026-01-05T09:00:00.000Z",
      id: PROJECT_ID,
      name: "Default",
      slug: "default",
    },
    protectedEnvironments: ["production"],
  };
  await page.route(
    (url) => url.pathname === "/api/projects/default/access",
    (route) => route.fulfill({ json: access }),
  );
  await page.route(
    (url) => url.pathname === "/api/projects/default/service-accounts",
    (route) => route.fulfill({ json: { serviceAccounts: [] } }),
  );
  await page.goto("/settings/agent-access");

  const identities = page.getByTestId("agent-identities");
  await expect(identities).toContainText("Use an agent token when the agent works for you.");
  await expect(identities).toContainText(
    "Use a service account for CI or an agent that must keep working when you leave.",
  );
  await identities.getByRole("link", { name: "Default" }).click();
  await expect(page).toHaveURL(/\/projects\/default\?tab=service-accounts$/u);
  await expect(page.getByRole("tab", { name: "Service accounts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("link", { name: "Settings › Agent access" }).click();
  await expect(page).toHaveURL(/\/settings\/agent-access$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Agent access" })).toBeVisible();
});

test("someone who administers no project learns whom to ask, with no link to a service account", async ({
  page,
}) => {
  const state = seededState();
  state.projects = state.projects.map((project): Project => ({ ...project, role: "editor" }));
  await mockDashboardApi(page, state);
  await page.goto("/settings/agent-access");

  const identities = page.getByTestId("agent-identities");
  await expect(identities).toContainText("A project's admins create them; ask one of them.");
  await expect(identities.getByRole("link")).toHaveCount(0);
});
