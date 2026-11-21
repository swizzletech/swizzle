import type { Page } from "@playwright/test";
import type { RunStep } from "../src/lib/api";
import { ago, MINUTE } from "./dashboard-mock";

const WIDE_FLOW = `flowchart TD
  cron([Hourly schedule]) --> read[Mail: read the label Rechnungseingang]
  read --> pdf{PDF attached?}
  pdf -->|yes| sort[Model: classify the PDF]
  pdf -->|no| task["Tasks: ask for the invoice or check the document"]
  sort --> kind{Invoice or credit note?}
  kind -->|yes| upload[Ledger: upload the document]
  kind -->|no| task
  upload --> problem{Problem reported?}
  problem -->|yes| task
  problem -->|no| move[Mail: move to the archive label]
  task --> move
  move --> done([Report the result])
`;

const WIDE_STEPS = ["read", "sort", "upload", "task", "move"] as const;

export async function serveWideFlow(page: Page) {
  await page.route("**/dashboard/automations/verify-probe/mermaid?*", (route) =>
    route.fulfill({ json: { available: true, content: WIDE_FLOW, error: null } }),
  );
  await page.route("**/dashboard/automations/verify-probe/source?*", (route) =>
    route.fulfill({
      json: {
        automationSlug: "verify-probe",
        content: WIDE_STEPS.map((key) => `await runStep("${key}", work);`).join("\n"),
        deploymentId: "deployment-1",
        entrypoint: "main.js",
        error: null,
        language: "node",
        steps: WIDE_STEPS.map((key, index) => ({
          endLine: index + 1,
          key,
          kind: "step",
          startLine: index + 1,
          target: null,
        })),
      },
    }),
  );
  await page.route("**/dashboard/runs/*/steps*", (route) =>
    route.fulfill({
      json: WIDE_STEPS.map(
        (stepKey, index): RunStep => ({
          approval: null,
          attempt: 1,
          createdAt: ago(18 * MINUTE - index * 1_000),
          executionNumber: 1,
          finishedAt: ago(18 * MINUTE - index * 1_000 - 500),
          startedAt: ago(18 * MINUTE - index * 1_000),
          stepKey,
          updatedAt: ago(18 * MINUTE - index * 1_000 - 500),
          value: null,
        }),
      ),
    }),
  );
}
