import { expect, type Page, test } from "@playwright/test";

import type {
  CredentialAccessView,
  CredentialRight,
  ListedConnection,
  Person,
  SecretMetadata,
} from "../src/lib/api";
import { mockDashboardApi, PROJECT_ID, seededState } from "./dashboard-mock";

// Who may use and manage a secret or an account: the row's Access panel lists every holder with the
// sources of their right, and only a manager gets the controls that change them. A new secret joins
// the project in view, or the one its form picks.

const MIA: Person = {
  email: "mia@example.com",
  id: "user-mia",
  name: "Mia",
  role: "member",
  suspended: false,
  twoFactorEnabled: false,
};
const FINANCE_ID = "00000000-0000-4000-8000-0000000000f1";

function secret(right: CredentialRight): SecretMetadata {
  return {
    algorithm: "aes-256-gcm",
    createdAt: "2026-10-01T00:00:00.000Z",
    environment: "staging",
    id: "secret-crm",
    keyVersion: "v1",
    name: "CRM_TOKEN",
    project: { id: PROJECT_ID, name: "Default", slug: "default" },
    projectId: PROJECT_ID,
    right,
    secretVersion: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function connection(right: CredentialRight): ListedConnection {
  return {
    accessTokenExpiresAt: null,
    authorizationPending: false,
    clientId: "client-crm",
    createdAt: "2026-10-01T00:00:00.000Z",
    environment: "staging",
    id: "connection-crm",
    lastErrorAt: null,
    lastErrorCode: null,
    lastRefreshedAt: null,
    name: "crm-google",
    project: { id: PROJECT_ID, name: "Default", slug: "default" },
    provider: "google",
    right,
    scopes: [],
    status: "active",
    tokenVersion: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

type Credential = Pick<CredentialAccessView["credential"], "id" | "kind" | "name">;
const SECRET: Credential = { id: "secret-crm", kind: "secret", name: "CRM_TOKEN" };
const ACCOUNT: Credential = { id: "connection-crm", kind: "connection", name: "crm-google" };

function access(right: CredentialRight, credential: Credential): CredentialAccessView {
  return {
    credential: { ...credential, environment: "staging", projectId: PROJECT_ID },
    grants: [{ right: "use", subject: { kind: "team", teamId: "team-billing" } }],
    holders: [
      {
        email: "olga@example.com",
        instanceRole: null,
        members: null,
        name: "Olga",
        right: "manage",
        sources: [{ kind: "role", role: "project-admin" }],
        subject: { kind: "user", userId: "user-olga" },
        suspended: false,
      },
      {
        email: null,
        instanceRole: null,
        members: 2,
        name: "Billing",
        right: "use",
        sources: [{ kind: "grant", right: "use" }],
        subject: { kind: "team", teamId: "team-billing" },
        suspended: false,
      },
    ],
    right,
    serviceAccounts: [],
    shares: [],
  };
}

/** Answers the credential's access and grant routes; returns what the grant routes were sent. */
async function serveAccess(page: Page, right: CredentialRight, credential = SECRET) {
  const sent: {
    readonly method: string;
    readonly path: string;
    readonly url: string;
    readonly body: unknown;
  }[] = [];
  await page.route(`**/api/credentials/${credential.kind}/${credential.name}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/access")) {
      return await route.fulfill({ json: access(right, credential) });
    }
    sent.push({
      body: request.postDataJSON(),
      method: request.method(),
      path: url.pathname,
      url: url.search,
    });
    return await route.fulfill({ status: 204 });
  });
  await page.route("**/api/directory?*", (route) =>
    route.fulfill({
      json: { users: [{ id: MIA.id, name: MIA.name, email: MIA.email }], teams: [] },
    }),
  );
  return sent;
}

test("a manager sees each holder's source, grants a person use and removes a team's grant", async ({
  page,
}) => {
  const state = seededState();
  state.secrets = [secret("manage")];
  await mockDashboardApi(page, state);
  const sent = await serveAccess(page, "manage");

  await page.goto("/credentials");
  await page.getByTestId("secret").getByRole("button", { name: "Access" }).click();
  const panel = page.getByTestId("credential-access");
  await expect(panel.getByTestId("credential-holder").filter({ hasText: "Olga" })).toContainText(
    "as admin of its project",
  );
  await expect(panel.getByTestId("credential-holder").filter({ hasText: "Billing" })).toContainText(
    "use granted directly",
  );

  const form = panel.getByTestId("credential-grant-form");
  await form
    .getByRole("combobox", { name: "Who" })
    .selectOption({ label: "Mia (mia@example.com)" });
  await form.getByRole("radio", { name: /^use/u }).check();
  await form.getByRole("button", { name: "Grant" }).click();
  await panel.getByRole("button", { name: "Remove the grant of Billing" }).click();

  await expect.poll(() => sent.length).toBe(2);
  expect(sent[0]).toMatchObject({ body: { right: "use", user: MIA.id }, method: "PUT" });
  expect(sent[1]).toMatchObject({ method: "DELETE" });
  expect(new URLSearchParams(sent[1]?.url).get("team")).toBe("team-billing");
  // Olga holds it by role: there is no grant of hers to remove.
  await expect(panel.getByRole("button", { name: "Remove the grant of Olga" })).toHaveCount(0);
});

test("a holder with use sees the same list without a control that changes it", async ({ page }) => {
  const state = seededState();
  state.secrets = [secret("use")];
  await mockDashboardApi(page, state);
  await serveAccess(page, "use");

  await page.goto("/credentials");
  const row = page.getByTestId("secret");
  await expect(row.getByRole("button", { name: "Rotate" })).toHaveCount(0);
  await row.getByRole("button", { name: "Access" }).click();
  const panel = page.getByTestId("credential-access");
  await expect(panel.getByTestId("credential-holder")).toHaveCount(2);
  await expect(panel).toContainText("Only someone who manages it changes who holds what.");
  await expect(panel.getByRole("button", { name: /Remove/u })).toHaveCount(0);
  await expect(panel.getByTestId("credential-grant-form")).toHaveCount(0);
});

test("a manager grants and removes rights on an account through its own routes", async ({
  page,
}) => {
  const state = seededState();
  state.connections = [connection("manage")];
  await mockDashboardApi(page, state);
  const sent = await serveAccess(page, "manage", ACCOUNT);

  await page.goto("/credentials");
  const row = page.getByTestId("account").filter({ hasText: "crm-google" });
  await expect(row.getByRole("button", { name: "Delete" })).toBeVisible();
  await row.getByRole("button", { name: "Access" }).click();
  const panel = page.getByTestId("credential-access");
  const form = panel.getByTestId("credential-grant-form");
  await form
    .getByRole("combobox", { name: "Who" })
    .selectOption({ label: "Mia (mia@example.com)" });
  await form.getByRole("radio", { name: /^manage/u }).check();
  await form.getByRole("button", { name: "Grant" }).click();
  await panel.getByRole("button", { name: "Remove the grant of Billing" }).click();

  await expect.poll(() => sent.length).toBe(2);
  expect(sent.map(({ method, path }) => [method, path])).toEqual([
    ["PUT", "/api/credentials/connection/crm-google/grants"],
    ["DELETE", "/api/credentials/connection/crm-google/grants"],
  ]);
  expect(sent[0]?.body).toEqual({ right: "manage", user: MIA.id });
  expect(new URLSearchParams(sent[0]?.url).get("project")).toBe(PROJECT_ID);
});

test("a holder with use tests an account but neither changes it nor who holds it", async ({
  page,
}) => {
  const state = seededState();
  state.connections = [connection("use")];
  await mockDashboardApi(page, state);
  await serveAccess(page, "use", ACCOUNT);

  await page.goto("/credentials");
  const row = page.getByTestId("account").filter({ hasText: "crm-google" });
  await expect(row.getByRole("button", { name: "Test" })).toBeVisible();
  await expect(row.getByRole("button", { name: /^(Reconnect|Delete)$/u })).toHaveCount(0);
  await row.getByRole("button", { name: "Access" }).click();
  const panel = page.getByTestId("credential-access");
  await expect(panel.getByTestId("credential-holder")).toHaveCount(2);
  await expect(panel.getByRole("button", { name: /Remove/u })).toHaveCount(0);
  await expect(panel.getByTestId("credential-grant-form")).toHaveCount(0);
});

test("a new secret joins the project in view, or the one the form picks", async ({ page }) => {
  const state = seededState();
  state.projects = [
    {
      createdAt: "2026-01-05T09:00:00.000Z",
      id: PROJECT_ID,
      name: "Default",
      protectedEnvironments: [],
      role: "viewer",
      slug: "default",
    },
    {
      createdAt: "2026-01-05T09:00:00.000Z",
      id: FINANCE_ID,
      name: "Finance",
      protectedEnvironments: [],
      role: "editor",
      slug: "finance",
    },
  ];
  await mockDashboardApi(page, state);

  await page.goto("/credentials?project=finance");
  const form = page.getByTestId("add-secret");
  // Only the project the person edits is offered.
  await expect(
    form.getByRole("combobox", { name: "Project of the new secret" }).locator("option"),
  ).toHaveText(["Finance"]);
  await form.getByLabel("Secret name").fill("LEDGER_KEY");
  await form.getByLabel("Secret value").fill("value");
  await form.getByRole("button", { name: "Add secret" }).click();

  await expect(page.getByTestId("secret")).toContainText("Finance");
  const put = state.requests.find((request) => request.pathname === "/secrets/LEDGER_KEY");
  expect(put?.search.get("project")).toBe(FINANCE_ID);
});
