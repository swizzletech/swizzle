import { expect, test } from "@playwright/test";

import { APPROVAL_RUN_ID, mockDashboardApi, OK_RUN_ID, seededState } from "./dashboard-mock";

// A click aimed at one action never lands on another because the run changed state under the
// pointer: Open automation keeps its place and Run again appears where no button was. The panel
// stays mounted and picks each state up through its polling query.

type Box = { x: number; y: number; width: number; height: number };

for (const width of [390, 800, 1280]) {
  test(`at ${width} px a run changing state keeps Open automation and never puts Run again on another button`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.setViewportSize({ width, height: 800 });
    const state = seededState();
    const finished = state.runDetails.get(OK_RUN_ID);
    if (finished === undefined) throw new Error("Missing run fixture");
    const phases = [
      { ...finished, finishedAt: null, startedAt: null, status: "queued" as const },
      { ...finished, finishedAt: null, status: "running" as const },
      {
        ...finished,
        deadLetterReason: "retries-exhausted" as const,
        errorMessage: "Automation exited with code 1.",
        status: "dead-lettered" as const,
      },
    ];
    const [first, ...later] = phases;
    if (first === undefined) throw new Error("No phases");
    state.runDetails.set(OK_RUN_ID, first);
    await mockDashboardApi(page, state);
    await page.goto(`/runs?selected=${OK_RUN_ID}`);
    const panel = page.getByTestId("run-panel");

    const measure = async (name: string): Promise<Box | null> => {
      const target = panel.getByRole(name === "Open automation" ? "link" : "button", { name });
      return (await target.count()) === 1 ? target.boundingBox() : null;
    };
    await expect(panel.getByRole("button", { name: "Cancel run" })).toBeVisible();
    const openBox = await measure("Open automation");
    if (openBox === null) throw new Error("Open automation has no box");
    const seen: Box[] = [];
    const cancel = await measure("Cancel run");
    if (cancel !== null) seen.push(cancel);

    for (const next of later) {
      state.runDetails.set(OK_RUN_ID, next);
      await page.clock.runFor(3_000);
      await expect(panel.getByRole("heading", { name: /Running|Failed|Queued/ })).toBeVisible();
      if (next.status === "dead-lettered") {
        await expect(panel.getByRole("button", { name: "Run again" })).toBeVisible();
      } else {
        await expect(panel.getByRole("heading", { name: "Running" })).toBeVisible();
      }
      expect(await measure("Open automation")).toEqual(openBox);
      for (const name of ["Cancel run", "Run again"]) {
        const box = await measure(name);
        if (box === null) continue;
        if (name === "Run again") {
          for (const before of seen) {
            const overlaps =
              box.x < before.x + before.width &&
              before.x < box.x + box.width &&
              box.y < before.y + before.height &&
              before.y < box.y + box.height;
            expect(overlaps, "Run again overlaps a button the run had before").toBe(false);
          }
        }
        seen.push(box);
      }
    }
  });
}

// 480 and 1100 px are widths where the comment field and two buttons fit a row and the third
// does not; 800 px is the width the field test named.
for (const width of [480, 800, 1100]) {
  test(`at ${width} px the approval actions wrap as one group`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockDashboardApi(page, seededState());

    await page.goto(`/runs?selected=${APPROVAL_RUN_ID}`);
    const card = page.getByTestId("run-panel").getByTestId("approval-card");
    await expect(card.getByRole("button", { name: "Reassign" })).toBeVisible();
    const ys = [];
    for (const name of ["Approve", "Reject", "Reassign"]) {
      const box = await card.getByRole("button", { name, exact: true }).boundingBox();
      if (box === null) throw new Error(`${name} has no box`);
      ys.push(Math.round(box.y));
    }
    // The three buttons share one line, so none is stranded.
    expect(new Set(ys).size).toBe(1);
  });
}

// At 200% zoom the effective viewport can be narrower than the buttons side by side. The run panel
// clips overflow, so each button must wrap to a line inside it.
for (const width of [260]) {
  test(`at ${width} px every approval button stays inside the run panel`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockDashboardApi(page, seededState());

    await page.goto(`/runs?selected=${APPROVAL_RUN_ID}`);
    const panel = page.getByTestId("run-panel");
    await expect(panel.getByRole("button", { name: "Reassign" })).toBeAttached();
    const panelBox = await panel.boundingBox();
    if (panelBox === null) throw new Error("the run panel has no box");
    for (const name of ["Approve", "Reject", "Reassign"]) {
      const box = await panel.getByRole("button", { name, exact: true }).boundingBox();
      if (box === null) throw new Error(`${name} has no box`);
      expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(
        panelBox.x + panelBox.width,
      );
    }
  });
}
