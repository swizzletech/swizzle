import { expect, test } from "@playwright/test";

import {
  emptyState,
  FAILED_RUN_ID,
  mockDashboardApi,
  PROJECT_ID,
  seededState,
} from "./dashboard-mock";

// A control the viewer's role refuses is not offered; the page says once what it needs and where
// the viewer's role comes from.

const OPERATOR = {
  protectedEnvironment: null,
  required: "editor",
  role: "operator",
  scope: null,
  sources: [{ on: "project", projectId: PROJECT_ID, role: "operator", via: null }],
} as const;

test("an operator sees why Pause and Move to folder are not offered", async ({ page }) => {
  const state = seededState();
  state.automationRefusals = { edit: OPERATOR, organize: OPERATOR, run: null };
  await mockDashboardApi(page, state);

  await page.goto("/automations/verify-probe");

  await expect(page.getByText("Run now", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
  await expect(page.getByRole("group").filter({ hasText: "Move to folder" })).toHaveCount(0);
  await expect(page.getByLabel("More")).toHaveCount(0);
  await expect(page.getByTestId("refused-controls")).toHaveText(
    "Pause and Move to folder need editor. Your role here is operator, from operator on the project. Ask an admin of this project.",
  );
});

test("an operator sees why New folder is not offered", async ({ page }) => {
  const state = seededState();
  state.folders = { create: OPERATOR, folders: [] };
  await mockDashboardApi(page, state);

  await page.goto("/");

  await expect(page.getByTestId("automations")).toBeVisible();
  await expect(page.getByRole("button", { name: "+" })).toHaveCount(0);
  await expect(page.getByTestId("refused-controls")).toHaveText(
    "New folder needs editor. Your role here is operator, from operator on the project. Ask an admin of this project.",
  );
});

test("a viewer's empty Overview says who deploys instead of the steps to a first one", async ({
  page,
}) => {
  const state = emptyState();
  state.deploy = {
    ...OPERATOR,
    role: "viewer",
    sources: [{ on: "project", projectId: PROJECT_ID, role: "viewer", via: null }],
  };
  await mockDashboardApi(page, state);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Nothing runs here yet." })).toBeVisible();
  await expect(page.getByTestId("refused-controls")).toHaveText(
    "Deploy needs editor. Your role here is viewer, from viewer on the project. Ask an admin of this project.",
  );
  await expect(page.getByTestId("empty-steps")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create agent token" })).toHaveCount(0);
});

test("a viewer's failed run offers no Hand to agent and says what it needs", async ({ page }) => {
  const state = seededState();
  const viewer = {
    ...OPERATOR,
    role: "viewer",
    sources: [{ on: "project", projectId: PROJECT_ID, role: "viewer", via: null }],
  } as const;
  const detail = state.runDetails.get(FAILED_RUN_ID);
  if (detail === undefined) throw new Error("The seeded state lost its failed run.");
  state.runDetails.set(FAILED_RUN_ID, {
    ...detail,
    refusals: { cancel: null, edit: viewer, runAgain: { ...viewer, required: "operator" } },
  });
  await mockDashboardApi(page, state);

  await page.goto(`/automations/verify-probe?run=${FAILED_RUN_ID}`);

  const panel = page.getByTestId("run-panel");
  await expect(panel.getByRole("heading", { name: "Failed" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Hand to agent" })).toHaveCount(0);
  await expect(panel.getByTestId("refused-controls")).toHaveText(
    "Hand to agent needs editor and Run again needs operator. Your role here is viewer, from viewer on the project. Ask an admin of this project.",
  );
});
