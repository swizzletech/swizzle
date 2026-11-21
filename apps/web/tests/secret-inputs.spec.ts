import { expect, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

test("secret value fields are masked text that password managers skip", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto("/credentials?connect=google&name=google-jan");
  await page.getByTestId("page-head").getByRole("button", { name: "Add secret" }).click();

  for (const field of [
    page.getByLabel("Value of VERIFY_SECRET"),
    page.getByTestId("add-secret").getByLabel("Secret value"),
    page.getByTestId("connect-form").getByLabel("Client secret"),
  ]) {
    await expect(field).toHaveAttribute("type", "text");
    await expect(field).toHaveAttribute("autocomplete", "off");
    await expect(field).toHaveAttribute("data-1p-ignore", "true");
    await expect(field).toHaveAttribute("data-lpignore", "true");
    await expect(field).toHaveAttribute("data-bwignore", "true");
    await expect(field).toHaveCSS("-webkit-text-security", "disc");
  }
});

test("a typed secret value stays out of the accessibility tree", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto("/credentials");
  await page.getByTestId("page-head").getByRole("button", { name: "Add secret" }).click();
  const form = page.getByTestId("add-secret");
  await form.getByLabel("Secret name").fill("probe");
  const field = form.getByLabel("Secret value");

  await field.pressSequentially("hunter2");
  await field.press("ArrowLeft");
  await field.press("ArrowLeft");
  await field.press("Backspace");
  await page.evaluate(() => navigator.clipboard.writeText("XY"));
  await field.press("ControlOrMeta+V");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { selectionEnd: 2, selectionStart: 2, text: "ka" });
  await cdp.send("Input.insertText", { text: "か" });

  expect(await form.ariaSnapshot()).not.toMatch(/hunt|XY|か/u);
  await expect(field).toHaveCSS("-webkit-text-security", "disc");
  await field.press("Enter");
  await expect
    .poll(() => state.requests.find((request) => request.method === "PUT")?.body)
    .toEqual({ value: "huntXYかr2" });
});

test("editing a secret value keeps whole characters", async ({ page }) => {
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto("/credentials");
  await page.getByTestId("page-head").getByRole("button", { name: "Add secret" }).click();
  const field = page.getByTestId("add-secret").getByLabel("Secret value");
  await page.getByTestId("add-secret").getByLabel("Secret name").fill("probe");

  await field.focus();
  await page.keyboard.insertText("a😀b");
  await expect(field).toHaveValue("•••");
  await field.press("ArrowLeft");
  await field.press("Backspace");
  await page.keyboard.insertText("𝄞");
  await field.press("Home");
  await field.press("Delete");
  await field.press("Enter");
  await expect
    .poll(() => state.requests.find((request) => request.method === "PUT")?.body)
    .toEqual({ value: "𝄞b" });
});

test("a secret value set without an edit event is masked and sent", async ({ page }) => {
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto("/credentials");
  await page.getByTestId("page-head").getByRole("button", { name: "Add secret" }).click();
  const form = page.getByTestId("add-secret");
  await form.getByLabel("Secret name").fill("probe");
  const field = form.getByLabel("Secret value");

  await field.pressSequentially("ab");
  await field.evaluate((input: HTMLInputElement) => {
    input.value = `${input.value.slice(0, 1)}XY${input.value.slice(1)}`;
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await expect(field).toHaveValue("••••");
  expect(await form.ariaSnapshot()).not.toMatch(/XY/u);
  await field.press("Enter");
  await expect
    .poll(() => state.requests.find((request) => request.method === "PUT")?.body)
    .toEqual({ value: "aXYb" });
});
