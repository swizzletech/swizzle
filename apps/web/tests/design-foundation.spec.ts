import { expect, type Locator, type Page, test } from "@playwright/test";

import scale from "../design-scale.json" with { type: "json" };
import type { AutomationSummary, ProjectHolder, TokenResponse } from "../src/lib/api";
import {
  APPROVAL_RUN_ID,
  addOlderRuns,
  FAILED_RUN_ID,
  type MockState,
  mockDashboardApi,
  PROJECT_ID,
  seededState,
} from "./dashboard-mock";

// The foundation in apps/web/src/styles.css, read off what a page draws. Every page and tab, in
// light, dark and at phone width, fails on a visible element outside the scale in
// apps/web/design-scale.json or on text below 4.5:1 against its background. An element that may
// differ is listed by name in EXCEPTIONS with its reason. The last tests plant off-scale values, so
// the walk is known to see them.

type Property = "height" | "padding" | "gap" | "font-size";

const EXCEPTIONS: readonly {
  readonly selector: string;
  readonly property: Property;
  readonly reason: string;
}[] = [
  {
    property: "height",
    reason: "A segment is 24 px inside its 32 px switch, 32 px inside the 40 px switch of a phone.",
    selector: ".tab",
  },
  {
    property: "height",
    reason: "A tab takes the height of its 40 px bar; the bar, not the tab, is the control.",
    selector: ".dtab",
  },
  {
    property: "height",
    reason: "A row of a list, or a station of the Play's phone code, is a button as tall as it.",
    selector: ".rrow, .rp-child, .st-hit, .st-card",
  },
  {
    property: "height",
    reason: "A multi-line field grows with its rows.",
    selector: "textarea.field",
  },
  {
    property: "height",
    reason: "A link in running text takes the height of its line.",
    selector: ".linkish, .member, .track-fold",
  },
];

const OWNER = {
  createdAt: "2026-10-01T00:00:00.000Z",
  email: "owner@example.com",
  id: "owner-1",
  name: "Owner",
  role: "owner",
  suspended: false,
  twoFactorEnabled: false,
} as const;

/** The page's own computed styles, as lines naming the element and what is off. */
function auditPage(input: {
  readonly scale: typeof scale;
  readonly exceptions: typeof EXCEPTIONS;
  readonly phone: boolean;
}): string[] {
  const { exceptions, phone } = input;
  const found = new Set<string>();
  const context = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;
  type Rgba = readonly [number, number, number, number];
  // The canvas reads every form a computed colour takes, color-mix and oklch among them.
  const parsed = new Map<string, Rgba>();
  const rgba = (color: string): Rgba => {
    const known = parsed.get(color);
    if (known !== undefined) return known;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    const value = [r, g, b, a / 255] as const;
    parsed.set(color, value);
    return value;
  };
  const over = (top: Rgba, under: Rgba): Rgba => {
    const mix = (index: 0 | 1 | 2) => top[index] * top[3] + under[index] * (1 - top[3]);
    return [mix(0), mix(1), mix(2), 1];
  };
  const background = (element: Element): Rgba => {
    const layers: Rgba[] = [];
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const layer = rgba(getComputedStyle(node).backgroundColor);
      if (layer[3] > 0) layers.push(layer);
      if (layer[3] === 1) break;
    }
    return layers.reduceRight<Rgba>((under, top) => over(top, under), [255, 255, 255, 1]);
  };
  const opacity = (element: Element): number => {
    let value = 1;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      value *= Number(getComputedStyle(node).opacity);
    }
    return value;
  };
  const luminance = ([r, g, b]: Rgba): number => {
    const channel = (value: number) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const excepted = (element: Element, property: Property) =>
    exceptions.some(
      (exception) => exception.property === property && element.matches(exception.selector),
    );
  const nameOf = (element: Element) => {
    const classes = [...element.classList].slice(0, 3).join(".");
    const text = element.textContent?.trim().slice(0, 24) ?? "";
    return `<${element.tagName.toLowerCase()}${classes === "" ? "" : `.${classes}`}> "${text}"`;
  };
  const report = (element: Element, what: string) => found.add(`${nameOf(element)}: ${what}`);
  const px = (value: string) => Number.parseFloat(value);

  for (const element of document.querySelectorAll("body *")) {
    if (element.closest("svg") !== null && element.tagName !== "text") continue;
    if (element.tagName === "OPTION") continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const style = getComputedStyle(element);

    const field =
      element.matches("input, select, textarea") &&
      !element.matches('[type="checkbox"], [type="radio"], [type="range"]');
    const text =
      field || [...element.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
    if (text) {
      const size = px(style.fontSize);
      if (!input.scale.fontSizes.includes(size) && !excepted(element, "font-size")) {
        report(element, `font size ${style.fontSize}`);
      }
      if (!input.scale.fontWeights.includes(Number(style.fontWeight))) {
        report(element, `font weight ${style.fontWeight}`);
      }
    }

    for (const corner of ["TopLeft", "TopRight", "BottomLeft", "BottomRight"] as const) {
      const radius = style[`border${corner}Radius`];
      if (radius === "50%" || radius === "999px" || radius === "0px") continue;
      if (!input.scale.radii.includes(px(radius))) report(element, `radius ${radius}`);
    }
    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      if (style[`border${side}Style`] === "none") continue;
      const width = px(style[`border${side}Width`]);
      if (width !== 0 && !input.scale.borderWidths.includes(width)) {
        report(element, `border width ${width}px`);
      }
    }
    if (!excepted(element, "padding")) {
      for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
        const padding = style[`padding${side}`];
        if (!input.scale.spacing.includes(px(padding))) report(element, `padding ${padding}`);
      }
    }
    if (!excepted(element, "gap")) {
      for (const gap of [style.rowGap, style.columnGap]) {
        if (gap !== "normal" && !input.scale.spacing.includes(px(gap))) {
          report(element, `gap ${gap}`);
        }
      }
    }

    const control =
      element.matches(".btn, .field, button, select") ||
      element.matches('input:not([type="checkbox"], [type="radio"], [type="range"])');
    if (control && !excepted(element, "height")) {
      const allowed = phone ? [input.scale.phoneControlHeight] : input.scale.controlHeights;
      if (!allowed.includes(Math.round(box.height))) {
        report(element, `control height ${box.height}px`);
      }
    }

    if (element.matches(".setting, [data-testid='holder']")) {
      const actions = [...element.querySelectorAll("button.btn")].filter(
        (button) => button.closest("details, form, [data-testid='reset-link']") === null,
      );
      if (actions.length > 1) report(element, `${actions.length} visible actions in a row`);
    }

    if (text && element.closest(':disabled, [aria-disabled="true"]') === null) {
      const fill = element.tagName === "text" ? style.fill : style.color;
      const [r, g, b, a] = rgba(fill);
      const behind = background(element);
      const ink = over([r, g, b, a * opacity(element)], behind);
      const [light, dark] = [luminance(ink), luminance(behind)].toSorted((x, y) => y - x);
      const ratio = ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
      if (ratio < 4.5) report(element, `contrast ${ratio.toFixed(2)}:1`);
    }
  }
  return [...found].toSorted();
}

function audit(page: Page, phone: boolean): Promise<string[]> {
  return page.evaluate(auditPage, { exceptions: EXCEPTIONS, phone, scale });
}

const AT = "2026-11-01T09:00:00.000Z";
const MIA = {
  ...OWNER,
  email: "mia@example.com",
  id: "user-mia",
  name: "Mia",
  role: "member",
  twoFactorEnabled: true,
};
const PROJECT = { id: PROJECT_ID, name: "Default", slug: "default" };
const TOKEN = {
  createdAt: AT,
  expiresAt: "2027-11-01T09:00:00.000Z",
  id: "token-1",
  issuedBy: null,
  lastUsedAt: AT,
  name: "CI deploys",
  revokedAt: null,
  scope: { environments: null, projects: null, role: "admin" },
  tokenPrefix: "swz_abc",
} satisfies TokenResponse;
const GRANT = {
  environment: null,
  role: "editor",
  subject: { kind: "user", userId: MIA.id },
  via: null,
} as const;
const PERSON_HOLDER = {
  email: MIA.email,
  environments: { staging: { cap: null, role: "editor" } },
  instanceRole: null,
  members: null,
  name: MIA.name,
  role: "editor",
  subject: GRANT.subject,
  suspended: false,
  teamGrants: [],
} satisfies ProjectHolder;
const SHARE = {
  acceptedAt: null,
  acceptedBy: null,
  createdAt: AT,
  credential: { environment: "staging", id: "secret-in", kind: "secret", name: "LEDGER_KEY" },
  credentialProject: { id: "project-finance", name: "Finance", slug: "finance" },
  offeredBy: OWNER.id,
  project: PROJECT,
  shareId: "share-1",
};

/** Answers every list a page shows, so the walk audits rows and not the empty or error state. */
async function asOwner(page: Page, state: MockState) {
  state.secrets = [
    {
      algorithm: "aes-256-gcm",
      createdAt: AT,
      environment: "staging",
      id: "secret-crm",
      keyVersion: "v1",
      name: "CRM_TOKEN",
      project: PROJECT,
      projectId: PROJECT_ID,
      right: "manage",
      secretVersion: 1,
      updatedAt: AT,
    },
  ];
  state.connections = [
    {
      accessTokenExpiresAt: null,
      authorizationPending: false,
      clientId: "client-crm",
      createdAt: AT,
      environment: "staging",
      id: "connection-crm",
      lastErrorAt: null,
      lastErrorCode: null,
      lastRefreshedAt: AT,
      name: "crm-google",
      project: PROJECT,
      provider: "google",
      right: "manage",
      scopes: [],
      status: "active",
      tokenVersion: 1,
      updatedAt: AT,
    },
  ];
  state.tokens = [TOKEN];
  await mockDashboardApi(page, state);
  await page.route(
    (url) => url.pathname === "/api/auth/status",
    (route) =>
      route.fulfill({
        json: { authenticated: true, mailConfigured: true, setupRequired: false, user: OWNER },
      }),
  );
  for (const [path, json] of [
    ["/api/users", { users: [OWNER, MIA] }],
    [
      "/api/invitations",
      {
        invitations: [
          {
            createdAt: AT,
            email: "new@example.com",
            expiresAt: "2027-01-01T09:00:00.000Z",
            grants: [],
            id: "invitation-1",
            invitedBy: OWNER.id,
            role: "member",
          },
        ],
      },
    ],
    ["/api/teams", { teams: [{ id: "team-1", memberIds: [MIA.id], name: "Release" }] }],
    ["/api/directory", { teams: [], users: [{ email: MIA.email, id: MIA.id, name: MIA.name }] }],
    [
      "/api/workers",
      {
        workers: [
          {
            capabilities: null,
            capacity: 2,
            createdAt: AT,
            credentialGeneration: 1,
            currentRuns: [],
            draining: false,
            environments: "all",
            id: "worker-1",
            kind: "remote",
            lastSeenAt: AT,
            localLlm: null,
            name: "Office PC",
            profiles: ["default"],
            runImageDisk: null,
            runImageDiskOverBudget: null,
            runImageDiskWarning: null,
            services: [],
            slotsInUse: 0,
            state: "online",
            tokenExpiresAt: null,
          },
        ],
      },
    ],
    [
      "/api/projects/default/access",
      {
        automationSlugs: {},
        environments: ["staging", "production"],
        grants: [GRANT],
        holders: [PERSON_HOLDER],
        project: { ...PROJECT, createdAt: AT },
        protectedEnvironments: ["production"],
      },
    ],
    [
      "/api/projects/default/service-accounts",
      {
        serviceAccounts: [
          {
            createdAt: AT,
            createdBy: { id: OWNER.id, name: OWNER.name },
            grants: [],
            id: "account-1",
            name: "ci",
            projectId: PROJECT_ID,
            tokens: [TOKEN],
          },
        ],
      },
    ],
    ["/api/projects/default/credential-shares", { shares: [SHARE] }],
    [
      "/api/projects/default/shared-credentials",
      {
        credentials: [
          {
            credential: { ...SHARE.credential, projectId: PROJECT_ID },
            shares: [{ ...SHARE, acceptedAt: AT, acceptedBy: OWNER.id }],
          },
        ],
      },
    ],
  ] as const) {
    await page.route(
      (url) => url.pathname === path,
      (route) => route.fulfill({ json }),
    );
  }
}

interface Stop {
  readonly name: string;
  readonly path: string;
  /** What to open before the audit; the state to wait for is part of it. */
  readonly open?: (page: Page) => Promise<void>;
}

const SETTINGS = [
  "agent-access",
  "notifications",
  "account",
  "two-factor",
  "people",
  "teams",
  "workers",
  "status",
] as const;

const STOPS: readonly Stop[] = [
  { name: "Overview", path: "/" },
  { name: "Runs", path: "/runs" },
  { name: "Runs, a failed run", path: `/runs?selected=${FAILED_RUN_ID}` },
  { name: "Runs, an approval", path: `/runs?selected=${APPROVAL_RUN_ID}` },
  { name: "Runs, nothing matches", path: "/runs?status=running&automation=nothing" },
  { name: "Automation, Runs", path: "/automations/verify-probe" },
  { name: "Automation, an approval", path: `/automations/verify-probe?run=${APPROVAL_RUN_ID}` },
  { name: "Automation, About", path: "/automations/verify-probe?tab=about" },
  { name: "Automation, Play", path: "/automations/verify-probe?tab=play" },
  { name: "Automation, Versions", path: "/automations/verify-probe?tab=versions" },
  { name: "Projects", path: "/projects" },
  { name: "Project, Access", path: "/projects/default" },
  { name: "Project, Environments", path: "/projects/default?tab=environments" },
  { name: "Project, Service accounts", path: "/projects/default?tab=service-accounts" },
  { name: "Project, Credentials", path: "/projects/default?tab=credentials" },
  { name: "Credentials", path: "/credentials" },
  {
    name: "Credentials, Add secret",
    open: (page) => page.getByRole("button", { name: "Add secret" }).click(),
    path: "/credentials",
  },
  {
    name: "Credentials, Connect an account",
    open: (page) => page.getByRole("button", { name: "Connect an account" }).click(),
    path: "/credentials",
  },
  ...SETTINGS.map((section) => ({ name: `Settings, ${section}`, path: `/settings/${section}` })),
  { name: "Not found", path: "/no-such-page" },
];

const MODES = [
  { name: "light", phone: false, scheme: "light", viewport: { height: 900, width: 1440 } },
  { name: "dark", phone: false, scheme: "dark", viewport: { height: 900, width: 1440 } },
  { name: "phone", phone: true, scheme: "light", viewport: { height: 844, width: 390 } },
] as const;

async function settled(page: Page) {
  await expect(page.locator("body")).not.toBeEmpty();
  await expect(page.locator('.skeleton, [aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

for (const mode of MODES) {
  test.describe(mode.name, () => {
    test.use({ colorScheme: mode.scheme, viewport: mode.viewport });

    for (const stop of STOPS) {
      test(`${stop.name} stays on the foundation`, async ({ page }) => {
        const state = seededState();
        addOlderRuns(state, 120);
        await asOwner(page, state);
        await page.goto(stop.path);
        await expect(page.getByTestId("page-head")).toBeVisible();
        await stop.open?.(page);
        await settled(page);
        expect(await audit(page, mode.phone)).toEqual([]);
      });
    }

    test("the sign-in screen stays on the foundation", async ({ page }) => {
      await mockDashboardApi(page, seededState(), { authenticated: false });
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await settled(page);
      expect(await audit(page, mode.phone)).toEqual([]);
    });
  });
}

test.describe("every page", () => {
  test.use({ viewport: { height: 900, width: 1440 } });

  for (const [name, path, type] of [
    ["Overview", "/", "overview"],
    ["Runs", "/runs", "workbench"],
    ["Automation, Runs", "/automations/verify-probe", "workbench"],
    ["Automation, About", "/automations/verify-probe?tab=about", "reading"],
    ["Automation, Versions", "/automations/verify-probe?tab=versions", "administration"],
    ["Projects", "/projects", "administration"],
    ["Project", "/projects/default", "administration"],
    ["Credentials", "/credentials", "administration"],
    ["Settings", "/settings/account", "administration"],
    ["Not found", "/no-such-page", "reading"],
  ] as const) {
    test(`${name} is a ${type} page under the one shared head`, async ({ page }) => {
      await asOwner(page, seededState());
      await page.goto(path);
      await expect(page.locator(`.page[data-page-type="${type}"]`)).toBeVisible();
      await expect(page.getByTestId("page-head")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator(".page-head h1")).toBeVisible();
    });
  }

  test("a deep page names its parent above the title, and a place does not", async ({ page }) => {
    await asOwner(page, seededState());
    await page.goto("/automations/verify-probe");
    const trail = page.getByRole("navigation", { name: "Trail" });
    await expect(trail).toContainText("Overview/verify-probe");
    await trail.getByRole("link", { name: "Overview" }).click();
    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview");
    await expect(trail).toHaveCount(0);
  });

  test("the five places stand together, the environment reads as one more row", async ({
    page,
  }) => {
    await asOwner(page, seededState());
    await page.goto("/");
    const places = page.getByRole("navigation", { name: "Dashboard" }).getByRole("link");
    await expect(places).toHaveText(["Overview3", "Runs", "Projects", "Credentials", "Settings"]);

    const geometry = await page.evaluate(() => {
      const box = (selector: string) =>
        document.querySelector(selector)?.getBoundingClientRect() as DOMRect;
      const row = document.querySelector(".envrow") as Element;
      const middle = (rect: DOMRect) => rect.left + rect.width / 2;
      return {
        border: getComputedStyle(row).borderTopWidth,
        dot: middle(box(".envrow .led")),
        icon: middle(box(".navlink .icon")),
        navHeight: box(".navlink").height,
        navLeft: box(".navlink").left,
        rowHeight: box(".envrow").height,
        rowLeft: box(".envrow").left,
      };
    });
    expect(geometry.border).toBe("0px");
    expect(geometry.rowHeight).toBe(geometry.navHeight);
    expect(geometry.rowLeft).toBe(geometry.navLeft);
    expect(geometry.dot).toBe(geometry.icon);

    await page.getByRole("combobox", { name: "Environment" }).selectOption("production");
    await expect(page.locator(".envrow .name")).toHaveText("production");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("the Overview shows a day with failures, and links to them", async ({ page }) => {
    const state = seededState();
    state.needsYou = [];
    await asOwner(page, state);
    await page.goto("/");
    const status = page.getByTestId("status-card");
    await expect(status).toContainText("Nothing needs you");
    await expect(status).toContainText(
      "1 run failed in the last 24 hours, the last one 4 min ago.",
    );
    await expect(status).not.toContainText("All good");
    await status.getByRole("link", { name: "Show failed runs" }).click();
    await expect(page).toHaveURL(/\/runs\?status=failed/u);
  });

  test("a credential row shows one action, its menu the rest, and Delete still confirms", async ({
    page,
  }) => {
    const state = seededState();
    await asOwner(page, state);
    await page.goto("/credentials");
    const row = page.getByTestId("secret").first();
    await expect(row.getByRole("button", { name: "Rotate" })).toBeVisible();
    await expect(row.locator("button.btn:visible")).toHaveCount(1);

    await row.getByLabel("More").click();
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("dialog")).toContainText("Delete");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(row).toBeVisible();
  });
});

const CHECKED_API: AutomationSummary["apiCheck"] = {
  entrypoint: "check.ts",
  everyMs: 86_400_000,
  mode: "active",
  record: {
    consecutiveFailures: 0,
    deploymentId: "deployment-1",
    failingSince: null,
    lastCheckedAt: AT,
    lastExitCode: 0,
    lastGreenAt: AT,
    lastGreenOutput: '{"ok":true}',
    lastGreenReport: {
      change: null,
      checked: ["GET openrouter /key", "GET openrouter /models", "GET mailbox /labels"],
      ok: true,
    },
    lastOutput: '{"ok":true}',
    lastReport: null,
    lastStderrTail: null,
    lastWarning: null,
    nextCheckAt: AT,
    status: "green",
  },
  secrets: null,
};

// One rule for every page type: beside a 240 px sidebar, content fills a narrow window and stops at
// 1600 px, so wider windows share one right edge.
test.describe("one width", () => {
  for (const [width, edge] of [
    [1440, 1408],
    [1920, 1808],
    [2560, 1808],
  ] as const) {
    test(`at ${width} wide every page type ends at ${edge}`, async ({ page }) => {
      await page.setViewportSize({ height: 900, width });
      await asOwner(page, seededState());
      const rightOf = async (selector: string) => {
        await expect(page.locator(selector).first()).toBeVisible();
        return await page
          .locator(selector)
          .evaluateAll((all) => Math.max(...all.map((one) => one.getBoundingClientRect().right)));
      };

      await page.goto("/runs");
      expect(await rightOf(".work")).toBe(edge);
      expect((await page.locator(".side").boundingBox())?.width).toBe(240);
      const actionsAt = new Set<number | undefined>();
      for (const tab of ["", "?tab=about", "?tab=play", "?tab=versions"]) {
        await page.goto(`/automations/verify-probe${tab}`);
        expect(await rightOf(".page-head .btn")).toBe(edge);
        actionsAt.add((await page.locator(".page-actions").boundingBox())?.x);
      }
      expect(actionsAt.size).toBe(1);
      for (const path of ["/", "/projects", "/credentials", "/settings/account"]) {
        await page.goto(path);
        expect(await rightOf(".page-content .card")).toBe(edge);
        const content = await page.locator(".page-content").boundingBox();
        expect(content?.width).toBeLessThanOrEqual(1600);
      }
    });
  }

  test("a README keeps its reading measure inside a wide card", async ({ page }) => {
    await page.setViewportSize({ height: 1080, width: 1920 });
    await asOwner(page, seededState());
    await page.route("**/dashboard/automations/verify-probe/readme?*", (route) =>
      route.fulfill({
        json: {
          automationSlug: "verify-probe",
          available: true,
          content: "Words. ".repeat(200),
          environment: "staging",
          error: null,
          filePath: "README.md",
        },
      }),
    );
    await page.goto("/automations/verify-probe?tab=about");
    const text = await page.getByTestId("automation-readme").locator("p").boundingBox();
    expect(text?.width).toBe(720);
  });
});

// A version reads one way in the sans face, numbers line up in a row, and a code value in a narrow
// panel breaks at its spaces.
test.describe("what a value looks like", () => {
  test.use({ viewport: { height: 900, width: 1440 } });

  const family = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).fontFamily.split(",")[0]);

  test("a version has one form on every surface, in the sans face", async ({ page }) => {
    const state = seededState();
    await asOwner(page, state);
    await page.goto("/");
    const change = page.getByText("v1.0.0 → v1.1.0");
    await expect(change).toBeVisible();
    expect(await family(change)).toBe("Geist");

    await page.goto("/automations/verify-probe");
    await expect(page.getByTestId("page-head")).toContainText("v1.1.0 deployed");
    await expect(page.getByTestId("run-row").first()).toContainText("v1.1.0");
    await page.goto("/automations/verify-probe?tab=versions");
    await expect(page.getByText("Deployed v1.1.0").first()).toBeVisible();
  });

  test("a run row's digits are all one width, so 3.1 s cannot read as 31 s", async ({ page }) => {
    await asOwner(page, seededState());
    await page.goto("/runs");
    const line = page.getByTestId("run-row").first().locator(".rrow-line");
    const widths = await line.evaluate((row) =>
      ["1", "8"].map((digit) => {
        const probe = row.appendChild(document.createElement("span"));
        probe.textContent = digit.repeat(10);
        const { width } = probe.getBoundingClientRect();
        probe.remove();
        return width;
      }),
    );
    expect(widths[0]).toBe(widths[1]);
  });

  test("the failed run panel keeps its gap, and a code value breaks at spaces", async ({
    page,
  }) => {
    const state = seededState();
    state.automations = state.automations.map((one) =>
      one.automationSlug === "verify-probe" ? { ...one, apiCheck: CHECKED_API } : one,
    );
    await asOwner(page, state);
    await page.goto(`/runs?selected=${FAILED_RUN_ID}`);
    const hand = page.getByTestId("run-panel").getByRole("button", { name: "Hand to agent" });
    const gap = await hand.evaluate((button) => {
      const above = button.previousElementSibling?.getBoundingClientRect().bottom ?? 0;
      return button.getBoundingClientRect().top - above;
    });
    expect(gap).toBe(12);

    await page.goto("/automations/verify-probe?tab=about");
    const value = page.getByTestId("api-check").getByText("GET openrouter /key");
    const lines = await value.evaluate((element) => {
      const text = element.firstChild;
      if (text === null) throw new Error("no text");
      const range = document.createRange();
      let at = 0;
      return (element.textContent ?? "").split(" ").map((word) => {
        range.setStart(text, at);
        range.setEnd(text, at + word.length);
        at += word.length + 1;
        return range.getClientRects().length;
      });
    });
    expect(new Set(lines)).toEqual(new Set([1]));
  });
});

test.describe("the walk sees", () => {
  test.use({ viewport: { height: 900, width: 1440 } });

  for (const [what, css, expected] of [
    ["a font size", ".t-page { font-size: 15px; }", "font size 15px"],
    ["a font weight", ".t-page { font-weight: 700; }", "font weight 700"],
    ["a radius", ".card { border-radius: 10px; }", "radius 10px"],
    ["a border", ".card { border-width: 3px; }", "border width 3px"],
    ["padding", ".page-head { padding: 14px; }", "padding 14px"],
    ["a gap", ".page-actions { gap: 10px; }", "gap 10px"],
    ["a control height", ".btn { height: 30px; }", "control height 30px"],
    ["low contrast", ".t-faint, .page-description { color: #b4b4b4; }", "contrast"],
  ] as const) {
    test(`${what} put back off the scale`, async ({ page }) => {
      await asOwner(page, seededState());
      await page.goto("/credentials");
      await expect(page.getByTestId("page-head")).toBeVisible();
      await settled(page);
      expect(await audit(page, false)).toEqual([]);
      await page.addStyleTag({ content: css });
      expect((await audit(page, false)).join("\n")).toContain(expected);
    });
  }

  test("a second visible action put back in a row", async ({ page }) => {
    await asOwner(page, seededState());
    await page.goto("/credentials");
    await expect(page.getByTestId("secret")).toBeVisible();
    await settled(page);
    await page.getByTestId("secret").evaluate((row) => {
      row.lastElementChild?.insertAdjacentHTML(
        "afterbegin",
        '<button class="btn small">Go</button>',
      );
    });
    expect((await audit(page, false)).join("\n")).toContain("2 visible actions in a row");
  });
});
