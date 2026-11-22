import { expect, test } from "@playwright/test";

import { emptyState, mockDashboardApi, PROJECT_ID, seededState } from "./dashboard-mock";

const FINANCE_ID = "00000000-0000-4000-8000-0000000000f1";

test("the sidebar has exactly five places", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto("/runs");

  const links = page.getByRole("navigation", { name: "Dashboard" }).getByRole("link");
  await expect(links).toHaveText(["Overview3", "Runs", "Projects", "Credentials", "Settings"]);
  await expect(links.nth(1)).toHaveAttribute("aria-current", "page");
});

for (const path of ["/secrets", "/connections", "/alerting", "/settings/cli-access"]) {
  test(`${path} no longer exists`, async ({ page }) => {
    await mockDashboardApi(page, seededState());
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
  });
}

test("an old tab or status in a link opens the default view", async ({ page }) => {
  await mockDashboardApi(page, seededState());

  await page.goto("/automations/verify-probe?tab=readme");
  await expect(page.getByRole("tab", { name: "Runs" })).toHaveAttribute("aria-selected", "true");

  await page.goto("/runs?status=dead-letter");
  await expect(page.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("run-list")).toBeVisible();
});

test("an empty instance shows only the three steps to the first automation", async ({ page }) => {
  await mockDashboardApi(page, emptyState());
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Nothing runs here yet" })).toBeVisible();
  await expect(page.getByTestId("empty-steps").getByRole("heading")).toHaveText([
    "Connect your agent",
    "Ask your agent",
    "It appears here",
  ]);
  await expect(page.getByTestId("needs-you")).toHaveCount(0);

  await page.getByRole("link", { name: "Create agent token" }).click();
  await expect(page).toHaveURL(/\/settings\/agent-access$/u);
});

test("a link the agent prints opens the connect form prefilled", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto("/credentials?connect=google&name=google-jan&scopes=drive.readonly,gmail.send");

  const form = page.getByTestId("connect-form");
  await expect(form.getByLabel("Service")).toHaveValue("google");
  await expect(form.getByLabel("Name")).toHaveValue("google-jan");
  await expect(form.getByLabel("Scopes (optional, one per line)")).toHaveValue(
    "drive.readonly\ngmail.send",
  );
  await expect(form).toContainText("https://swizzle.example.com/oauth/callback/google");
});

test("Connect in the Missing section opens the form for that account", async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const state = seededState();
  state.projects.push({
    createdAt: "2026-01-05T09:00:00.000Z",
    id: FINANCE_ID,
    name: "Finance",
    protectedEnvironments: [],
    role: "editor",
    slug: "finance",
  });
  state.overview = {
    ...state.overview,
    needsYou: [
      ...state.overview.needsYou,
      {
        connectionName: "google-ops",
        kind: "missing-connection",
        project: { id: FINANCE_ID, slug: "finance", name: "Finance" },
        provider: "google",
        status: "missing",
        usedBy: [{ automationName: "verify-vault", automationSlug: "verify-vault" }],
      },
    ],
  };
  await mockDashboardApi(page, state);
  await page.goto("/credentials");
  await expect(page.getByTestId("connect-form")).toHaveCount(0);

  await page.getByTestId("needs-you").getByRole("link", { name: "Connect" }).click();

  const form = page.getByTestId("connect-form");
  await expect(form.getByLabel("Service")).toHaveValue("google");
  await expect(form.getByLabel("Name")).toHaveValue("google-ops");
  await form.getByLabel("Client ID").fill("client-id");
  await form.getByLabel("Client secret").fill("client-secret");
  await form.getByRole("button", { name: "Continue to sign-in" }).click();
  await expect(page.getByRole("link", { name: "Open the sign-in page" })).toBeVisible();
  const authorized = state.requests.find(
    (request) => request.pathname === "/connections/google-ops/authorize",
  );
  expect(authorized?.search.get("project")).toBe(FINANCE_ID);
  expect(state.connections.map(({ name, project }) => ({ name, projectId: project.id }))).toEqual([
    { name: "google-ops", projectId: FINANCE_ID },
  ]);
});

test("Continue to sign-in reaches the consent page in one click", async ({ context, page }) => {
  await mockDashboardApi(page, seededState());
  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route(
    (url) => url.pathname.endsWith("/connections/google-jan/authorize"),
    async (route) => {
      await answered;
      await route.fallback();
    },
  );
  await context.route("https://accounts.example.com/**", (route) =>
    route.fulfill({ body: "<title>Consent</title>", contentType: "text/html" }),
  );
  await page.goto("/credentials?connect=google&name=google-jan");

  const form = page.getByTestId("connect-form");
  await form.getByLabel("Client ID").fill("client-id");
  await form.getByLabel("Client secret").fill("client-secret");
  const opened = page.waitForEvent("popup");
  await form.getByRole("button", { name: "Continue to sign-in" }).click();
  const popup = await opened;
  answer();

  await expect(popup).toHaveURL("https://accounts.example.com/consent?connection=google-jan");
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(page.getByText("Finish the sign-in in the window that opened.")).toBeVisible();
});

test("overlapping sign-ins each reach their own consent page", async ({ context, page }) => {
  const state = seededState();
  state.connections.push({
    accessTokenExpiresAt: null,
    authorizationPending: true,
    clientId: "client-id",
    createdAt: new Date().toISOString(),
    environment: "staging",
    id: `connection-${PROJECT_ID}-google-ops`,
    lastErrorAt: null,
    lastErrorCode: null,
    lastRefreshedAt: null,
    name: "google-ops",
    project: { id: PROJECT_ID, name: "Default", slug: "default" },
    provider: "google",
    right: "manage",
    scopes: [],
    status: "pending",
    tokenVersion: 0,
    updatedAt: new Date().toISOString(),
  });
  await mockDashboardApi(page, state);
  const answer = new Map<string, () => void>();
  for (const name of ["google-jan", "google-ops"]) {
    const answered = new Promise<void>((resolve) => answer.set(name, resolve));
    await page.route(
      (url) => url.pathname.endsWith(`/connections/${name}/authorize`),
      async (route) => {
        await answered;
        await route.fallback();
      },
    );
  }
  await context.route("https://accounts.example.com/**", (route) =>
    route.fulfill({ body: "<title>Consent</title>", contentType: "text/html" }),
  );
  await page.goto("/credentials?connect=google&name=google-jan");

  const form = page.getByTestId("connect-form");
  await form.getByRole("textbox", { name: "Client ID" }).fill("client-id");
  await form.getByLabel("Client secret").fill("client-secret");
  const connecting = page.waitForEvent("popup");
  await form.getByRole("button", { name: "Continue to sign-in" }).click();
  const connectWindow = await connecting;
  const reconnecting = page.waitForEvent("popup");
  await page.getByTestId("account").getByRole("button", { name: "Reconnect" }).click();
  const reconnectWindow = await reconnecting;

  answer.get("google-jan")?.();
  await expect(connectWindow).toHaveURL(
    "https://accounts.example.com/consent?connection=google-jan",
  );
  answer.get("google-ops")?.();
  await expect(reconnectWindow).toHaveURL(
    "https://accounts.example.com/consent?connection=google-ops",
  );
});

test("a blocked sign-in window says so and leaves a link to the sign-in page", async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await mockDashboardApi(page, seededState());
  await page.goto("/credentials?connect=google&name=google-jan");

  const form = page.getByTestId("connect-form");
  await form.getByLabel("Client ID").fill("client-id");
  await form.getByLabel("Client secret").fill("client-secret");
  await form.getByRole("button", { name: "Continue to sign-in" }).click();

  await expect(page.getByText("Your browser blocked the sign-in window.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the sign-in page" })).toHaveAttribute(
    "href",
    "https://accounts.example.com/consent?connection=google-jan",
  );
});

test("at phone width the header shows every place without cutting one off", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await mockDashboardApi(page, seededState());
  await page.goto("/credentials");

  const links = page.getByRole("navigation", { name: "Dashboard" }).getByRole("link");
  await expect(links).toHaveCount(5);
  for (const link of await links.all()) await expect(link).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("combobox", { name: "Environment" })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: "Sign out" })).toBeInViewport({ ratio: 1 });
});

test("at 320 px no page scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ height: 700, width: 320 });
  await mockDashboardApi(page, seededState());
  for (const [path, ready] of [
    ["/", page.getByRole("heading", { level: 1 })],
    ["/runs", page.getByRole("heading", { level: 1 })],
    ["/projects", page.getByRole("heading", { level: 1 })],
    ["/credentials", page.getByRole("heading", { level: 1 })],
    ["/settings/agent-access", page.getByRole("heading", { level: 1 })],
    ["/automations/verify-probe?tab=play", page.getByTestId("play")],
  ] as const) {
    await page.goto(path);
    await expect(ready.first(), path).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(() => ({
            header: document.querySelector(".side")?.scrollWidth,
            page: document.documentElement.scrollWidth,
          })),
        { message: path },
      )
      .toEqual({ header: 320, page: 320 });
  }
});

test("at phone width a detail page keeps its link back to the parent", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await mockDashboardApi(page, seededState());
  await page.goto("/automations/verify-probe");

  const trail = page.getByRole("navigation", { name: "Trail" });
  await expect(trail.getByRole("link", { name: "Overview" })).toBeInViewport({ ratio: 1 });
  await trail.getByRole("link", { name: "Overview" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(trail).toBeHidden();
});

test("the dashboard serves its icon", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto("/");

  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  const icon = await page.request.get("/favicon.svg");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
});

test("About shows the webhook URL the API names for the trigger", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto("/automations/verify-probe?tab=about");

  await expect(
    page.getByText("https://swizzle.example.com/api/hooks/verify-probe?environment=staging", {
      exact: true,
    }),
  ).toBeVisible();
});

test("the phone sidebar loads a head-only logo", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto("/");
  const logo = page.getByRole("link", { name: "Swizzle overview" }).getByRole("img");
  await expect(logo).toBeVisible();
  const desktop = await logo.boundingBox();
  expect(desktop?.width).toBeGreaterThan(100);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await logo.boundingBox())?.width ?? 0).toBeLessThan(30);
  await expect(logo).toBeInViewport({ ratio: 1 });
});
