import { expect, type Page, test } from "@playwright/test";

import { mockDashboardApi, PROJECT_ID, seededState } from "./dashboard-mock";

// Every popup closes on a click outside it and on Escape, and Escape returns focus to the button
// that opened it: the menus that open under their button and the Delete project dialog.

interface MenuCase {
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
  readonly button: (page: Page) => ReturnType<Page["getByText"]>;
  readonly field: (page: Page) => ReturnType<Page["getByLabel"]>;
}

const MORE: MenuCase = {
  name: "the automation's ⋯",
  open: (page) => page.goto("/automations/verify-probe").then(() => undefined),
  button: (page) => page.getByLabel("More"),
  field: (page) => page.getByLabel("Move to folder"),
};

const FOLDER_MENU: MenuCase = {
  name: "the folder's ⋯",
  open: async (page) => {
    await page.goto("/");
    await page.getByRole("tab", { name: /Reports/u }).click();
  },
  button: (page) => page.getByLabel("Folder actions"),
  field: (page) => page.getByRole("textbox", { name: "Folder name" }),
};

const MENUS: readonly MenuCase[] = [
  {
    name: "Run now",
    open: (page) => page.goto("/automations/verify-probe").then(() => undefined),
    button: (page) => page.getByText("Run now", { exact: true }),
    field: (page) => page.getByLabel("Payload (optional JSON)"),
  },
  MORE,
  FOLDER_MENU,
];

async function load(page: Page, menu: MenuCase): Promise<void> {
  const state = seededState();
  const now = new Date().toISOString();
  state.folders = {
    create: null,
    folders: [
      {
        createdAt: now,
        id: "folder-reports",
        name: "Reports",
        projectId: PROJECT_ID,
        refusal: null,
        sortOrder: 0,
        updatedAt: now,
      },
    ],
  };
  await mockDashboardApi(page, state);
  await menu.open(page);
  await menu.button(page).click();
  await expect(menu.field(page)).toBeVisible();
}

for (const menu of MENUS) {
  test(`${menu.name} closes on a click outside it and returns focus to its button`, async ({
    page,
  }) => {
    await load(page, menu);
    await menu.field(page).focus();
    await page.getByRole("heading", { level: 1 }).click();
    await expect(menu.field(page)).toBeHidden();
    await expect(menu.button(page)).toBeFocused();
  });

  test(`${menu.name} opens fully on screen at phone width`, async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await load(page, menu);
    const { left, right } = await page
      .locator(".menu-body", { has: menu.field(page) })
      .evaluate((body) => body.getBoundingClientRect());
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(390);
  });

  test(`${menu.name} closes on Escape and returns focus to its button`, async ({ page }) => {
    await load(page, menu);
    await menu.field(page).focus();
    await page.keyboard.press("Escape");
    await expect(menu.field(page)).toBeHidden();
    await expect(menu.button(page)).toBeFocused();
  });
}

test("a click outside a menu on another control leaves focus on that control", async ({ page }) => {
  await load(page, MORE);
  await page.getByRole("tab", { name: "About" }).click();
  await expect(page.getByLabel("Move to folder")).toBeHidden();
  await expect(page.getByRole("tab", { name: "About" })).toBeFocused();
});

test("opening a menu from the keyboard closes the one already open", async ({ page }) => {
  await load(page, MORE);
  await page.getByLabel("More").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByText("Run now", { exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Payload (optional JSON)")).toBeVisible();
  await expect(page.getByLabel("Move to folder")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Payload (optional JSON)")).toBeHidden();
  await expect(page.getByText("Run now", { exact: true })).toBeFocused();
});

test("the Delete project dialog closes on a click on its backdrop and on Escape", async ({
  page,
}) => {
  const state = seededState();
  state.projects.push({
    createdAt: "2026-10-01T00:00:00.000Z",
    id: "00000000-0000-4000-8000-0000000000f1",
    name: "Finance",
    protectedEnvironments: [],
    role: "admin",
    slug: "finance",
  });
  await mockDashboardApi(page, state);
  await page.goto("/projects/finance");
  const button = page.getByRole("button", { name: "Delete project" });
  const dialog = page.getByRole("dialog", { name: "Delete Finance" });

  await button.click();
  await dialog.getByRole("heading").click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();

  await button.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
});

test("a refused folder deletion shows its error after the menu closes", async ({ page }) => {
  await load(page, FOLDER_MENU);
  await page.route("**/automation-folders/folder-reports", (route) =>
    route.fulfill({
      contentType: "application/json",
      json: { code: "FOLDER_NOT_FOUND", error: "FOLDER_NOT_FOUND", message: "No such folder." },
      status: 404,
    }),
  );
  await page.getByRole("button", { name: "Delete folder", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete folder" }).click();
  await expect(page.getByLabel("Folder name")).toBeHidden();
  await expect(page.getByRole("alert").filter({ hasText: "No such folder." })).toBeVisible();
});
