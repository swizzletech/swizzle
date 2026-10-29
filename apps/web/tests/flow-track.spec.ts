import { expect, test } from "@playwright/test";

import { APPROVAL_RUN_ID, mockDashboardApi, OK_RUN_ID, seededState } from "./dashboard-mock";

for (const [syntax, source] of [
  ["front matter", (nodes: string) => `---\ntitle: Steps\n---\nflowchart LR\n ${nodes}\n`],
  ["semicolons", (nodes: string) => `flowchart LR; ${nodes};`],
  [
    "quoted comment marker",
    (nodes: string) => `flowchart LR\n ${nodes.replace("fetch", 'fetch["100%% complete"]')}\n`,
  ],
] as const) {
  test(`flow drift uses the shared node ids with ${syntax}`, async ({ page }) => {
    await mockDashboardApi(page, seededState());
    let nodes = "fetch --> gate --> notify";
    await page.route("**/dashboard/automations/verify-probe/mermaid?*", (route) =>
      route.fulfill({
        json: {
          available: true,
          content: source(nodes),
          error: null,
        },
      }),
    );
    await page.goto("/automations/verify-probe");
    const track = page.getByTestId("flow-track");
    await expect(track.locator('[data-testid="station"][data-step]')).toHaveCount(3);
    await expect(track.getByTestId("flow-drift")).toHaveCount(0);

    nodes = "fetch --> gate";
    await page.reload();
    await expect(track.getByTestId("flow-drift")).toHaveText("1 step without a node");
    await expect(track.getByTestId("flow-drift")).toHaveAttribute(
      "title",
      /step "notify" .* has no node/u,
    );
  });
}

// The track above the runs and the Play tab, on verify-probe's flowchart: the waiting station
// carries the decision, the fold outlives a reload, the code reads the run's position, and the
// phone folds the rail into cards above the code.

// A phone puts the track below the chosen run, so the decision stays in the panel at the top.
test("at phone width the run panel keeps the approval and the station below carries none", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDashboardApi(page, seededState());
  await page.goto(`/automations/verify-probe?run=${APPROVAL_RUN_ID}`);

  const card = page.getByTestId("run-panel").getByTestId("approval-card");
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  const gate = page.getByTestId("flow-track").locator('[data-testid="station"][data-step="gate"]');
  await expect(gate).toHaveAttribute("data-state", "waiting");
  await expect(gate.getByRole("button")).toHaveCount(0);
});

test("Approve on the waiting station, with no approval card beside it", async ({ page }) => {
  const state = seededState();
  await mockDashboardApi(page, state);
  await page.goto(`/automations/verify-probe?run=${APPROVAL_RUN_ID}`);

  const track = page.getByTestId("flow-track");
  const gate = track.locator('[data-testid="station"][data-step="gate"]');
  await expect(gate).toHaveAttribute("data-state", "waiting");
  await expect(track.locator('[data-testid="station"][data-step="fetch"]')).toHaveAttribute(
    "data-state",
    "done",
  );
  await expect(track.locator('[data-testid="station"][data-step="notify"]')).toHaveAttribute(
    "data-state",
    "idle",
  );
  await expect(gate).toContainText("Refund 120 € for order 4411?");
  await expect(gate).toContainText("Assigned to anna@example.com");
  await expect(page.getByTestId("run-panel").getByTestId("approval-card")).toHaveCount(0);

  // Folded, the station is gone, so the panel's card comes back; unfolded it leaves again.
  await page.getByRole("button", { name: "Flow" }).click();
  await expect(page.getByTestId("run-panel").getByTestId("approval-card")).toBeVisible();
  await page.getByRole("button", { name: "Flow" }).click();
  await expect(page.getByTestId("run-panel").getByTestId("approval-card")).toHaveCount(0);

  await gate.getByRole("button", { name: "Approve", exact: true }).click();
  await expect
    .poll(
      () =>
        state.requests.find(
          (request) => request.pathname === `/runs/${APPROVAL_RUN_ID}/approvals/gate`,
        )?.body,
    )
    .toEqual({ approved: true });
  await expect(gate.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});

test("a decided approval reads in the run panel while the track shows the step done", async ({
  page,
}) => {
  await mockDashboardApi(page, seededState());
  await page.goto(`/automations/verify-probe?run=${OK_RUN_ID}`);
  const decision = page.getByTestId("run-panel").getByTestId("approval-decision");
  await expect(decision).toContainText("gate: Approved by anna@example.com");
  await expect(decision).toContainText("Assigned to anna@example.com");
  await expect(decision).toContainText("Looks right");
  await expect(
    page.getByTestId("flow-track").locator('[data-testid="station"][data-step="gate"]'),
  ).toHaveAttribute("data-state", "done");
});

test("a finished run replays: the code follows the clock through the wait and back to the end", async ({
  page,
}) => {
  await page.clock.install();
  await mockDashboardApi(page, seededState());
  await page.goto(`/automations/verify-probe?tab=play&run=${OK_RUN_ID}`);
  const code = page.getByTestId("play-code");
  await expect(code.locator('.pl[data-step="notify"] .tag')).toHaveText("done · 0.3 s");
  // The rail and the phone bar each hold a transport; the desktop reads the rail's.
  await expect(page.getByTestId("play-rail").getByTestId("play-transport")).toContainText(
    "waits compressed",
  );

  // The page's clock stands still from here, so the test decides where the replay is.
  await page.clock.pauseAt(Date.now() + 1_000);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  // The 4.6 s approval wait plays from 0.4 s to 1.9 s; the code reads it as waiting while it does.
  await page.clock.runFor(1_000);
  await expect(code.locator('.pl[data-step="gate"]').first()).toHaveClass(/waiting/u);
  await expect(code.locator('.pl[data-step="notify"]').first()).not.toHaveClass(/done/u);
  await expect(
    page.getByTestId("play-track").locator('[data-testid="station"][data-step="gate"]'),
  ).toHaveAttribute("data-state", "waiting");
  // The replay ends at 2.25 s: the record is exact again and the transport offers Play once more.
  await page.clock.runFor(1_500);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(code.locator('.pl[data-step="notify"] .tag')).toHaveText("done · 0.3 s");
  await expect(code.locator('.pl[data-step="gate"]').first()).toHaveClass(/done/u);
});

test("the fold is remembered across a reload", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto("/automations/verify-probe");
  const fold = page.getByRole("button", { name: "Flow" });
  await expect(page.getByTestId("track")).toBeVisible();
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("track")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "Flow" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByTestId("track")).toHaveCount(0);
});

test("Play reads the waiting step in colour and greys the rest", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto(`/automations/verify-probe?tab=play&run=${APPROVAL_RUN_ID}`);

  const code = page.getByTestId("play-code");
  await expect(code).toHaveClass(/has-active/u);
  const gateLines = code.locator('.pl[data-step="gate"]');
  await expect(gateLines).toHaveCount(3);
  await expect(gateLines.first()).toHaveClass(/waiting/u);
  await expect(gateLines.first()).toHaveClass(/focus/u);
  await expect(gateLines.first().locator(".tag")).toHaveText("waiting for approval");
  await expect(code.locator('.pl[data-step="fetch"]')).toHaveClass(/done/u);
  await expect(code.locator('.pl[data-step="fetch"]')).not.toHaveClass(/focus/u);
  await expect(code.locator('.pl[data-step="notify"] .tag')).toHaveText("step");
  await expect(
    page.getByTestId("play-track").locator('[aria-current="step"][data-step="gate"]'),
  ).toBeVisible();

  // Clicking a station pins its code instead.
  await page
    .getByTestId("play-track")
    .locator('[data-testid="station"][data-step="fetch"] button')
    .click();
  await expect(code.locator('.pl[data-step="fetch"]')).toHaveClass(/focus/u);
  await expect(gateLines.first()).not.toHaveClass(/focus/u);
});

test("the phone puts each station above its code and the decision at the bottom", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await mockDashboardApi(page, seededState());
  await page.goto(`/automations/verify-probe?tab=play&run=${APPROVAL_RUN_ID}`);

  await expect(page.getByTestId("play-rail")).toBeHidden();
  await expect(page.getByTestId("play-pin")).toContainText("Approve refund?");
  await expect(
    page.getByTestId("play-code").locator('.station.st-card[data-step="gate"]'),
  ).toBeVisible();
  await expect(
    page.getByTestId("play-approve").getByRole("button", { name: "Reject", exact: true }),
  ).toBeVisible();
});

test("the Overview pipeline row opens its graph", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto("/");
  await page.getByTestId("pipeline-graph-toggle").click();
  const graph = page.getByTestId("pipeline-graph");
  await expect(graph.locator('[data-testid="station"][data-step="fetch-sales"]')).toBeVisible();
  await expect(graph.locator('[data-testid="station"][data-step="build-report"]')).toBeVisible();
  await expect(graph.locator(".lane")).toHaveCount(1);
});

test("at 1280x720 a seven-station track fits its card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockDashboardApi(page, seededState());
  await page.route("**/dashboard/automations/verify-probe/mermaid?*", (route) =>
    route.fulfill({
      json: {
        available: true,
        content: `flowchart LR
  trigger([Webhook]) --> fetch[Fetch the order]
  fetch --> check{Over 100?}
  check -->|yes| gate[Ask for approval]
  check -->|no| cool[Cool down]
  gate --> cool
  cool --> notify[Notify]
  notify --> done([Result])`,
        error: null,
      },
    }),
  );
  await page.goto(`/automations/verify-probe?run=${OK_RUN_ID}`);

  const track = page.getByTestId("flow-track");
  await expect(track.getByTestId("station")).toHaveCount(7);
  // The whole station, border included, inside what the track's scroll area shows.
  const visible = await track.locator(".track-scroll").boundingBox();
  const last = await track.getByTestId("station").filter({ hasText: "Result" }).boundingBox();
  if (visible === null || last === null)
    throw new Error("The track or its last station is missing.");
  expect(last.x + last.width).toBeLessThanOrEqual(visible.x + visible.width);
  expect(
    await track.locator(".track-scroll").evaluate((area) => area.scrollWidth - area.clientWidth),
  ).toBeLessThanOrEqual(0);
});

// The track lays stations out before it renders, so it estimates how tall the details grow. A
// full-width heading wraps at about half the characters a Latin one does.
test("an approval with long CJK details keeps its buttons inside the station", async ({ page }) => {
  const state = seededState();
  const details = {
    message: "このご注文の返金を承認しますか？お客様はすでに商品を返送済みで、金額は確認済みです。",
    顧客メモ:
      "返品された商品は倉庫で検品され、傷や汚れは見つかりませんでした。全額返金で問題ありません。",
  };
  const waiting = state.runDetails.get(APPROVAL_RUN_ID);
  if (waiting?.approval)
    state.runDetails.set(APPROVAL_RUN_ID, {
      ...waiting,
      approval: { ...waiting.approval, details },
    });
  await mockDashboardApi(page, state);
  await page.goto(`/automations/verify-probe?run=${APPROVAL_RUN_ID}`);

  const track = page.getByTestId("flow-track");
  const gate = track.locator('[data-testid="station"][data-step="gate"]');
  await expect(gate).toContainText("このご注文の返金を承認しますか");
  await track.screenshot({
    path: `${process.env.SWIZZLE_PROOF_DIR ?? process.env.SWIZZLE_E2E_OUTPUT_DIR}/cjk-station.png`,
  });
  // The buttons sit inside the station's frame, not below it.
  const { approveBottom, stationBottom } = await gate.evaluate((station) => ({
    approveBottom: [...station.querySelectorAll("button")]
      .find((button) => button.textContent === "Approve")
      ?.getBoundingClientRect().bottom,
    stationBottom: station.getBoundingClientRect().bottom,
  }));
  expect(approveBottom).toBeLessThanOrEqual(stationBottom);
});

// A decision draws one hexagon: its own box border stays clear whatever the station's state.
test("a decision node has a single outline in every state", async ({ page }) => {
  await mockDashboardApi(page, seededState());
  await page.goto(`/automations/verify-probe?run=${OK_RUN_ID}`);

  const decision = page.getByTestId("flow-track").locator(".station.diamond");
  await expect(decision).toHaveCount(1);
  for (const state of ["idle", "done", "failed"]) {
    await decision.evaluate((node, next) => {
      node.setAttribute("class", `station diamond narration ${next}`);
    }, state);
    expect(await decision.evaluate((node) => getComputedStyle(node).borderTopColor), state).toBe(
      "rgba(0, 0, 0, 0)",
    );
  }
});
