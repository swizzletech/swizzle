import { expect, type Page, type Route, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

// Settings as an owner sees it: the section nav, its anchors under the phone's sticky header, the
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

for (const id of ["people", "teams", "workers", "instance", "two-factor"]) {
  test(`at phone width /settings#${id} opens with its heading below the header`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await asOwner(page);
    await page.goto(`/settings#${id}`);

    const heading = page.locator(`[id="${id}"] h2`).first();
    await expect(heading).toBeInViewport();
    // Wait for the scroll to the anchor, then compare with the header's bottom edge.
    await expect
      .poll(async () => {
        const header = await page.locator("aside.side").boundingBox();
        const top = await heading.boundingBox();
        return header !== null && top !== null && top.y >= header.y + header.height;
      })
      .toBe(true);
  });
}

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

test("the section nav marks the section on screen", async ({ page }) => {
  await asOwner(page);
  await page.goto("/settings#teams");

  const nav = page.getByRole("navigation", { name: "Settings" });
  // The linked section is marked from the start; its heading on screen shows the jump happened.
  await expect(page.locator("#teams h2")).toBeInViewport();
  await expect(nav.locator("[aria-current]")).toHaveText(["Teams"]);

  // Instance is the last section, so the reader scrolls to the end of the page to read it.
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 10_000);
  await expect(nav.locator("[aria-current]")).toHaveText(["Instance"]);

  // Near the end of the page a clicked section cannot reach the top, and still is the one marked.
  await nav.getByRole("link", { name: "Workers" }).click();
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);
});

/** Holds the answers to `pathname` until the returned function lets them through. */
async function holdAnswers(
  page: Page,
  pathname: string,
  answer = (route: Route) => route.fallback(),
) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      await released;
      await answer(route);
    },
  );
  return release;
}

/**
 * Settings as an owner whose People list of 30 answers once the returned function lets it through,
 * with scroll anchoring `auto` or `none`.
 */
async function withPeopleHeld(page: Page, anchoring: string) {
  await asOwner(page);
  const people = Array.from({ length: 30 }, (_, index) => ({
    ...OWNER,
    email: `person-${index}@example.com`,
    id: `person-${index}`,
    name: `Person ${index}`,
  }));
  const release = await holdAnswers(page, "/api/users", (route) =>
    route.fulfill({ json: { users: people } }),
  );
  await page.addInitScript((value) => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.overflowAnchor = value;
    });
  }, anchoring);
  return release;
}

// Safari keeps no scroll anchor, so a section that grows above the target pushes it away unless the
// page follows; `none` turns Chrome's anchoring off to show that.
for (const anchoring of ["auto", "none"]) {
  test(`/settings#workers stays at Workers while People above it loads (scroll anchoring ${anchoring})`, async ({
    page,
  }) => {
    const answerPeople = await withPeopleHeld(page, anchoring);
    await page.goto("/settings#workers");
    await expect(page.locator("#workers h2")).toBeAttached();

    answerPeople();
    await expect(page.getByText("person-29@example.com")).toBeAttached();
    const nav = page.getByRole("navigation", { name: "Settings" });
    await expect(page.locator("#workers h2")).toBeInViewport();
    await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);
  });
}

test("typing in the Workers form while People loads keeps the page at Workers", async ({
  page,
}) => {
  const answerPeople = await withPeopleHeld(page, "none");
  await page.goto("/settings#workers");

  // A click and keys that scroll nothing are no scrolling away.
  const name = page.getByRole("textbox", { name: "Worker name" });
  await name.click();
  await page.keyboard.press("Shift+KeyG");
  await page.keyboard.type("pu-box");

  answerPeople();
  await expect(page.getByText("person-29@example.com")).toBeAttached();
  await expect(name).toBeInViewport();
  await expect(name).toHaveValue("Gpu-box");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);
});

test("Space on a focused control while People loads keeps the jump to Workers", async ({
  page,
}) => {
  const answerPeople = await withPeopleHeld(page, "none");
  await page.goto("/settings#workers");

  // Space opens a summary, or presses a button, and scrolls nothing.
  const history = page.locator("summary", { hasText: "Delivery history" });
  await history.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("details", { has: history })).toHaveAttribute("open");

  answerPeople();
  await expect(page.getByText("person-29@example.com")).toBeAttached();
  await expect(page.locator("#workers h2")).toBeInViewport();
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);
});

test("scrolling elsewhere while the sections load cancels the jump to the linked one", async ({
  page,
}) => {
  const answerPeople = await withPeopleHeld(page, "auto");
  await page.goto("/settings#workers");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);

  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 400);
  // The wheel moved the page before People answered.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  answerPeople();
  await expect(page.getByText("person-29@example.com")).toBeAttached();
  await expect(page.locator("#workers h2")).not.toBeInViewport();
  await expect(nav.locator("[aria-current]")).toHaveText(["Notifications"]);
});

test("/settings#workers scrolls to Workers while an unrelated query is still in flight", async ({
  page,
}) => {
  await asOwner(page);
  // The sidebar's Overview count has nothing to do with the sections' data, and never answers.
  await holdAnswers(page, "/api/dashboard/overview");
  await page.goto("/settings#workers");

  await expect(page.locator("#workers h2")).toBeInViewport();
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);
});

test("/settings#workers stays at Workers while the project list answers late (scroll anchoring none)", async ({
  page,
}) => {
  const state = seededState();
  state.projects = state.projects.flatMap((project) =>
    Array.from({ length: 8 }, (_, index) => ({
      ...project,
      id: `project-${index}`,
      name: `Project ${index}`,
    })),
  );
  await asOwner(page, state);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.overflowAnchor = "none";
    });
  });
  const answerProjects = await holdAnswers(page, "/api/projects");
  await page.goto("/settings#workers");
  await expect(page.getByText("owner@example.com").first()).toBeAttached();

  answerProjects();
  // People's invitation form lists the projects above Workers once they arrive.
  await expect(page.getByLabel("Project 7").first()).toBeAttached();
  // The jump left Workers at the top of the page; it is still there.
  await expect
    .poll(async () => (await page.locator("#workers h2").boundingBox())?.y ?? 9_999)
    .toBeLessThan(150);
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);
});

test("a click on the section the address already names marks it again", async ({ page }) => {
  await asOwner(page);
  await page.goto("/settings#workers");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(page.locator("#workers h2")).toBeInViewport();
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);

  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -10_000);
  await expect(nav.locator("[aria-current]")).toHaveText(["Agent access"]);

  // The address stays #workers, so no hashchange follows this click.
  await nav.getByRole("link", { name: "Workers" }).click();
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);
});

test("a reader who scrolls with the keyboard leaves the linked section", async ({ page }) => {
  await asOwner(page);
  await page.goto("/settings#workers");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(page.locator("#workers h2")).toBeInViewport();
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);

  await page.keyboard.press("Home");
  await expect(nav.locator("[aria-current]")).toHaveText(["Agent access"]);
});

test("/settings#workers stays marked when the page moves without the reader", async ({ page }) => {
  await asOwner(page);
  await page.goto("/settings#workers");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(page.locator("#workers h2")).toBeInViewport();
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);
  const scrollY = () => page.evaluate(() => window.scrollY);
  const belowBottom = () =>
    page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight - window.scrollY,
    );
  // Workers sits near the end, so the jump stopped at the bottom of the page.
  await expect.poll(belowBottom).toBe(0);
  const jumpedTo = await scrollY();

  // A taller window lowers the bottom, and the page follows it up without a scroll by the reader.
  await page.setViewportSize({ width: 1280, height: 820 });
  await expect.poll(scrollY).toBeLessThan(jumpedTo);
  await expect.poll(belowBottom).toBe(0);
  // The scroll event that move fires runs before the frame after next draws.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(page.locator("#workers h2")).toBeInViewport();
  await expect(nav.locator("[aria-current]")).toHaveText(["Workers"]);
});

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
  await page.goto("/settings#account");

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
  await page.goto("/settings#workers");

  const cards = page.getByTestId("worker");
  await expect(cards.nth(0)).toContainText("Idle · 0 of 1 slot in use");
  await expect(cards.nth(1)).toContainText("Revoked");
  await expect(cards.nth(1)).not.toContainText("slot");
});
