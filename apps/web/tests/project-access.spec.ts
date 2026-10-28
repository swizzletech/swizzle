import { expect, type Page, test } from "@playwright/test";

import type { Person, Project, ProjectAccess, ProjectHolder, Team } from "../src/lib/api";
import { mockDashboardApi, PROJECT_ID, seededState } from "./dashboard-mock";

// The sharing dialog: a project admin gives a team a role in the protected production environment.
// It shows what the person already holds through the team and what the role means for
// credentials, sends the grant the API's grant route takes, and shows the roles the API answers
// afterwards.

const MIA: Person = {
  email: "mia@example.com",
  id: "user-mia",
  name: "Mia",
  role: "member",
  suspended: false,
  twoFactorEnabled: false,
};
const RELEASE: Team = {
  createdAt: "2026-10-01T00:00:00.000Z",
  id: "team-release",
  memberIds: [MIA.id],
  name: "Release",
};
const FINANCE_ID = "00000000-0000-4000-8000-0000000000f1";

const RELEASE_EDITOR = {
  on: "project",
  projectId: PROJECT_ID,
  role: "editor",
  subject: { kind: "team", teamId: RELEASE.id },
  via: null,
} as const;

function holder(name: string, subject: ProjectHolder["subject"], production: "operator" | null) {
  const person = subject.kind === "user";
  return {
    email: person ? MIA.email : null,
    environments: {
      production: { cap: production, role: production },
      staging: { cap: null, role: "editor" },
    },
    instanceRole: null,
    members: person ? null : RELEASE.memberIds.length,
    name,
    role: "editor",
    subject,
    suspended: false,
    teamGrants: person ? [{ grant: RELEASE_EDITOR, teamName: RELEASE.name }] : [],
  } satisfies ProjectHolder;
}

/** Default with the team as project editor, and its production role as the API computes it. */
function access(production: "operator" | null): ProjectAccess {
  return {
    automationSlugs: {},
    environments: ["staging", "production"],
    grants: [RELEASE_EDITOR],
    holders: [
      holder(RELEASE.name, { kind: "team", teamId: RELEASE.id }, production),
      holder(MIA.name, { kind: "user", userId: MIA.id }, production),
    ],
    project: {
      createdAt: "2026-01-05T09:00:00.000Z",
      id: PROJECT_ID,
      name: "Default",
      slug: "default",
    },
    protectedEnvironments: ["production"],
  };
}

const PROJECTS: readonly Project[] = [
  {
    createdAt: "2026-01-05T09:00:00.000Z",
    id: PROJECT_ID,
    name: "Default",
    protectedEnvironments: ["production"],
    role: "admin",
    slug: "default",
  },
  {
    createdAt: "2026-01-05T09:00:00.000Z",
    id: FINANCE_ID,
    name: "Finance",
    protectedEnvironments: ["production"],
    role: "admin",
    slug: "finance",
  },
];

/** Answers the project and directory routes; a grant or protection change moves Default to `after`. */
async function serveProjects(page: Page, after: ProjectAccess, before = access(null)) {
  const sent: unknown[] = [];
  let current = before;
  const answers: Record<string, () => unknown> = {
    "/api/projects": () => ({ projects: PROJECTS }),
    "/api/projects/default/access": () => current,
    "/api/projects/finance/access": () => ({
      ...access(null),
      grants: [],
      holders: [],
      project: { id: FINANCE_ID, name: "Finance", slug: "finance" },
    }),
    "/api/directory": () => ({
      teams: [{ id: RELEASE.id, name: RELEASE.name }],
      users: [{ id: MIA.id, name: MIA.name, email: MIA.email }],
    }),
  };
  await page.route(
    (url) =>
      url.pathname in answers ||
      url.pathname === "/api/projects/default/grants" ||
      url.pathname.endsWith("/protection"),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.endsWith("/grants") || pathname.endsWith("/protection")) {
        sent.push(
          pathname.endsWith("/grants")
            ? route.request().postDataJSON()
            : `${route.request().method()} ${pathname}`,
        );
        current = after;
        return await route.fulfill({ status: 204 });
      }
      return await route.fulfill({ json: answers[pathname]?.() });
    },
  );
  return sent;
}

test("a project admin gives a team operator in the protected production environment", async ({
  page,
}) => {
  await mockDashboardApi(page, seededState());
  const sent = await serveProjects(page, access("operator"));

  await page.goto("/projects/default");
  const mia = page.getByTestId("holder").filter({ hasText: MIA.email });
  await expect(mia.getByTestId("environment-roles")).toContainText(
    "production (protected): no access",
  );
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const form = page.getByTestId("share-form");
  await form.getByRole("combobox", { name: "Who" }).selectOption({ label: "Team Release" });
  await expect(form.getByTestId("share-holds")).toContainText("editor on the project");
  await form.getByRole("radio", { name: "One protected environment" }).check();
  await form.getByRole("combobox", { name: "Environment to share" }).selectOption("production");
  await form.getByRole("radio", { name: /^operator/u }).check();
  await expect(form.getByRole("radio", { name: /^admin/u })).toHaveCount(0);
  await expect(form.getByTestId("credential-consequence")).toContainText(
    "this grant is the most they may do there",
  );
  await form.getByRole("button", { name: "Share", exact: true }).click();

  await expect(form).toHaveCount(0);
  expect(sent).toEqual([{ environment: "production", role: "operator", team: RELEASE.id }]);
  await expect(mia.getByTestId("environment-roles")).toContainText(
    "production (protected): operator",
  );
});

test("a team's grant in a protected environment reads as the cap it sets on its members", async ({
  page,
}) => {
  await mockDashboardApi(page, seededState());
  const team = { kind: "team", teamId: RELEASE.id } as const;
  const capped: ProjectAccess = {
    ...access(null),
    grants: [
      {
        environment: "production",
        on: "environment",
        projectId: PROJECT_ID,
        role: "editor",
        subject: team,
        via: null,
      },
    ],
    holders: [
      {
        ...holder(RELEASE.name, team, null),
        environments: {
          production: { cap: "editor", role: null },
          staging: { cap: null, role: null },
        },
        role: null,
      },
    ],
  };
  await serveProjects(page, capped, capped);

  await page.goto("/projects/default");
  const release = page.getByTestId("holder").filter({ hasText: RELEASE.name });
  await expect(release.getByTestId("environment-roles")).toContainText(
    "production (protected): caps members at editor",
  );
});

test("environment grants are offered only in protected environments, and unprotecting one removes them", async ({
  page,
}) => {
  await mockDashboardApi(page, seededState());
  const granted: ProjectAccess = {
    ...access("operator"),
    grants: [
      RELEASE_EDITOR,
      {
        environment: "production",
        on: "environment",
        projectId: PROJECT_ID,
        role: "operator",
        subject: { kind: "team", teamId: RELEASE.id },
        via: null,
      },
    ],
  };
  const sent = await serveProjects(page, { ...access(null), protectedEnvironments: [] }, granted);

  await page.goto("/projects/default");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const form = page.getByTestId("share-form");
  await form.getByRole("radio", { name: "One protected environment" }).check();
  await expect(
    form.getByRole("combobox", { name: "Environment to share" }).locator("option"),
  ).toHaveText(["production"]);
  await form.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("tab", { name: "Environments" }).click();
  const staging = page.getByTestId("environment").filter({ hasText: "staging" });
  const production = page.getByTestId("environment").filter({ hasText: "production" });
  await expect(staging).toContainText("Protect staging to grant access in it.");
  await expect(staging.getByRole("button", { name: "Grant access to staging" })).toHaveCount(0);
  await expect(production).toContainText("Environment grants: Release as operator.");

  await production.getByRole("checkbox", { name: "Protect production" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toHaveAccessibleName(
    "Unprotect production? This removes its 1 environment grant.",
  );
  await confirm.getByRole("button", { name: "Unprotect" }).click();

  await expect(production).toContainText("Protect production to grant access in it.");
  expect(sent).toEqual(["DELETE /api/projects/default/environments/production/protection"]);
  await expect(production).not.toContainText("Environment grants");
});

test("switching projects closes a sharing dialog prepared for the other project", async ({
  page,
}) => {
  await mockDashboardApi(page, seededState());
  const sent = await serveProjects(page, access("operator"));

  // With both projects' access cached, the page swaps projects without a loading state.
  await page.goto("/projects/finance");
  await expect(page.getByRole("heading", { name: "Finance", level: 1 })).toBeVisible();
  await page.getByRole("combobox", { name: "Project" }).selectOption("default");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("combobox", { name: "Who" }).selectOption({ label: "Team Release" });
  await page.getByRole("combobox", { name: "Project" }).selectOption("finance");

  await expect(page.getByRole("heading", { name: "Finance", level: 1 })).toBeVisible();
  await expect(page.getByTestId("share-form")).toHaveCount(0);
  expect(sent).toEqual([]);
});
