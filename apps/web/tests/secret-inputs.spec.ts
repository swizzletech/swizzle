import { expect, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

// Browsers offer to save what is typed into a password field, whatever its autocomplete says, and
// sync it to the owner's browser account. A secret value is a masked text field that password
// managers are told to skip, so it stays write-only.

test("secret value fields are masked text that password managers skip", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto("/credentials?connect=google&name=google-jan");

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

// A text field puts its value in the accessibility tree, where a screen reader reads it aloud and
// an agent driving the browser sees it. The field holds only mask characters; the value it sends
// is what was typed, edited, pasted and composed through an input method, and Enter still submits.
test("a typed secret value stays out of the accessibility tree", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto("/credentials");
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

// One mask character stands for one Unicode character, so an edit never splits a surrogate pair.
test("editing a secret value keeps whole characters", async ({ page }) => {
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto("/credentials");
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

// Autofill and some keyboards change a field without a cancelable beforeinput. The field still
// ends up masked and sends what the browser put there.
test("a secret value set without an edit event is masked and sent", async ({ page }) => {
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto("/credentials");
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
