import { expect, test } from "@playwright/test";

import type { ListedCredentialShare, Project, SharedCredential } from "../src/lib/api";
import { mockDashboardApi, PROJECT_ID, seededState } from "./dashboard-mock";

// A project's Credentials tab: its admin accepts a credential another project offers it, and offers
// a credential of its own to one more project and withdraws it from another, through the share
// routes of the API.

const FINANCE_ID = "00000000-0000-4000-8000-0000000000f1";
const LEGAL_ID = "00000000-0000-4000-8000-0000000000f2";

function project(id: string, name: string): Project {
  return {
    createdAt: "2026-01-05T09:00:00.000Z",
    id,
    name,
    protectedEnvironments: [],
    role: "admin",
    slug: name.toLowerCase(),
  };
}

function share(input: {
  readonly id: string;
  readonly name: string;
  readonly from: Project;
  readonly to: Project;
}): ListedCredentialShare {
  return {
    acceptedAt: null,
    acceptedBy: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    credential: {
      environment: "staging",
      id: `secret-${input.name}`,
      kind: "secret",
      name: input.name,
      projectId: input.from.id,
    },
    credentialProject: { id: input.from.id, name: input.from.name, slug: input.from.slug },
    offeredBy: "user-olga",
    projectId: input.to.id,
    project: { id: input.to.id, name: input.to.name, slug: input.to.slug },
    shareId: input.id,
  };
}

test("a project admin accepts an offer, offers a credential and withdraws it", async ({ page }) => {
  const DEFAULT = project(PROJECT_ID, "Default");
  const FINANCE = project(FINANCE_ID, "Finance");
  const state = seededState();
  state.projects = [DEFAULT, FINANCE, project(LEGAL_ID, "Legal")];
  await mockDashboardApi(page, state);

  let offered = share({ from: FINANCE, id: "share-in", name: "LEDGER_KEY", to: DEFAULT });
  const outgoing = share({ from: DEFAULT, id: "share-out", name: "CRM_TOKEN", to: FINANCE });
  const shared: SharedCredential[] = [{ credential: outgoing.credential, shares: [outgoing] }];
  // Each change the page sends: method, path, and the credential's project.
  const sent: (string | null)[][] = [];
  await page.route(
    (url) =>
      url.pathname.startsWith("/api/projects/default/") ||
      url.pathname.startsWith("/api/credentials/secret/CRM_TOKEN/shares/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname.endsWith("/credential-shares")) {
        return await route.fulfill({ json: { shares: [offered] } });
      }
      if (request.method() === "GET" && url.pathname.endsWith("/shared-credentials")) {
        expect(url.searchParams.get("environment")).toBe("staging");
        return await route.fulfill({ json: { credentials: shared } });
      }
      sent.push([request.method(), url.pathname, url.searchParams.get("project")]);
      if (url.pathname.endsWith("/credential-shares/share-in")) {
        offered = { ...offered, acceptedAt: "2026-10-02T00:00:00.000Z", acceptedBy: "user-me" };
        return await route.fulfill({ json: offered });
      }
      return await route.fulfill({ status: 204 });
    },
  );

  await page.goto("/projects/default?tab=credentials");
  const offer = page.getByTestId("offered-share").filter({ hasText: "LEDGER_KEY" });
  await expect(offer).toContainText("From Finance, in staging");
  await offer.getByRole("button", { name: "Accept" }).click();
  await expect(offer).toContainText("Accepted");
  await expect(offer.getByRole("button", { name: "End share" })).toBeVisible();

  const row = page.getByTestId("shared-credential").filter({ hasText: "CRM_TOKEN" });
  // Finance holds an offer already; only Legal is left to offer it to.
  const target = row.getByRole("combobox", { name: "Project to offer CRM_TOKEN to" });
  await expect(target.locator("option")).toHaveText(["Offer to…", "Legal"]);
  await target.selectOption({ label: "Legal" });
  await row.getByRole("button", { name: "Offer" }).click();
  await row.getByRole("button", { name: "Withdraw CRM_TOKEN from Finance" }).click();

  await expect.poll(() => sent.length).toBe(3);
  expect(sent).toEqual([
    ["PUT", "/api/projects/default/credential-shares/share-in", null],
    ["PUT", "/api/credentials/secret/CRM_TOKEN/shares/legal", PROJECT_ID],
    ["DELETE", `/api/credentials/secret/CRM_TOKEN/shares/${FINANCE_ID}`, PROJECT_ID],
  ]);
});
