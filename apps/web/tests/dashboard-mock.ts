import type { Page, Route } from "@playwright/test";
import type { API_ERROR_STATUS, ApiErrorCode, ApiErrorResponse } from "@swizzle/core";

import type {
  AttentionItem,
  AutomationDetail,
  AutomationFoldersResponse,
  AutomationSummary,
  CreatedApiToken,
  ListedConnection,
  Overview,
  Project,
  RunDetail,
  RunListItem,
  RunStep,
  ScopeInput,
  SecretMetadata,
  SignInResponse,
  TokenResponse,
  TriggerSummary,
} from "../src/lib/api";

// The API the dashboard flows run against: a seeded staging instance with one approval wait, one
// failing automation, one missing secret, a two-stage pipeline and a running cron, or an empty
// one. The mock changes its state the way the API would, so a flow sees the result of its action,
// and records every request, so a flow can assert what the dashboard sent.

const MINUTE = 60_000;
export const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

const DEFAULT_PROJECT: Project = {
  createdAt: "2026-01-05T09:00:00.000Z",
  id: PROJECT_ID,
  name: "Default",
  protectedEnvironments: ["production"],
  role: "admin",
  slug: "default",
};

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

interface MockRequest {
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
}

export interface MockState {
  automations: AutomationSummary[];
  connections: ListedConnection[];
  needsYou: AttentionItem[];
  /** What GET /projects answers: the projects the signed-in person sees. */
  projects: Project[];
  readonly recentChanges: Overview["recentChanges"];
  readonly requests: MockRequest[];
  readonly runDetails: Map<string, RunDetail>;
  runs: RunListItem[];
  secrets: SecretMetadata[];
  tokens: TokenResponse[];
  /** What the viewer may not do with every automation, as its detail answers; none by default. */
  automationRefusals: AutomationDetail["refusals"];
  /** The folder list as GET /automation-folders answers it; none and no refusal by default. */
  folders: AutomationFoldersResponse;
  /** Why the viewer may not deploy a new automation, as the Overview answers it; null by default. */
  deploy: Overview["deploy"];
  /** API paths no handler answered; a flow that ends with entries here missed a route. */
  readonly unhandled: string[];
}

function trigger(
  overrides: Partial<TriggerSummary> & {
    nextRun?: Extract<TriggerSummary, { triggerType: "cron" }>["nextRun"];
  },
): TriggerSummary {
  const { nextRun = null, ...summary } = overrides;
  const base: Omit<TriggerSummary, "triggerType"> = {
    chainOnStatus: null,
    chainHiddenSourceCount: 0,
    chainPayloadMode: null,
    chainSourceAutomationNames: [],
    chainSourceAutomationSlugs: [],
    cronIntervalMs: null,
    cronSchedule: null,
    deploymentId: "deployment-1",
    environment: "staging",
    errorCode: null,
    errorMessage: null,
    pausedAt: null,
    status: "active",
    triggerId: "trigger-1",
    updatedAt: ago(60 * MINUTE),
    versionId: "version-1",
    webhookPath: null,
    webhookUrl:
      overrides.webhookPath === undefined || overrides.webhookPath === null
        ? null
        : `https://swizzle.example.com/api${overrides.webhookPath}?environment=staging`,
    ...summary,
  };
  return overrides.triggerType === "cron"
    ? { ...base, triggerType: "cron", nextRun }
    : { ...base, triggerType: overrides.triggerType ?? "webhook" };
}

function run(
  overrides: Partial<RunListItem> & Pick<RunListItem, "automationSlug" | "runId" | "status">,
): RunListItem {
  return {
    approval: null,
    attemptsMade: 1,
    attemptsMax: 2,
    automationId: `id-${overrides.automationSlug}`,
    automationName: overrides.automationSlug,
    chainOriginRunId: null,
    chainSourceRunIds: [],
    childRunCount: 0,
    deadLetterReason: null,
    deploymentId: "deployment-1",
    environment: "staging",
    errorClassification: null,
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    parentRunId: null,
    parentStepKey: null,
    projectId: PROJECT_ID,
    queuedAt: ago(5 * MINUTE),
    startedAt: ago(5 * MINUTE),
    triggerType: "webhook",
    version: "1.1.0",
    versionId: "version-1",
    wait: null,

    ...overrides,
  };
}

function automation(
  slug: string,
  overrides: Partial<AutomationSummary> & Pick<AutomationSummary, "trigger">,
): AutomationSummary {
  return {
    activeDeployment: {
      deployedAt: ago(6 * MINUTE),
      deploymentId: `deployment-${slug}`,
      readiness: { errors: [], status: "ready", warnings: [] },
      seq: 2,
      sourceHash: "8f1c2a77d3e94b10",
      vars: {},
      version: "1.1.0",
    } as unknown as AutomationSummary["activeDeployment"],
    apiCheck: null,
    apiContacts: [],
    automationId: `id-${slug}`,
    automationName: slug,
    automationSlug: slug,
    description: null,
    environment: "staging",
    folderId: null,
    folderName: null,
    invokesAutomationSlugs: [],
    project: DEFAULT_PROJECT,
    lastRun: null,
    projectId: PROJECT_ID,
    recentRuns: [],
    requiredConnections: [],
    requiredSecrets: [],
    ...overrides,
  };
}

function glance(item: RunListItem): AutomationSummary["recentRuns"][number] {
  return {
    errorCode: item.errorCode,
    errorMessage: item.errorMessage,
    queuedAt: item.queuedAt,
    runId: item.runId,
    status: item.status,
    triggerType: item.triggerType,
  };
}

function detail(item: RunListItem, extra: Partial<RunDetail> = {}): RunDetail {
  return {
    ...item,
    // The seeded viewer is an owner: they decide an open approval and reassign it.
    approval:
      item.approval === null ? null : { ...item.approval, may: { decide: true, reassign: true } },
    executions: [],
    payload: { order: 4411 },
    placement: null,
    refusals: { cancel: null, edit: null, runAgain: null },
    result: null,
    stderr: "",
    stdout: "",
    ...extra,
  } as unknown as RunDetail;
}

const NO_REFUSALS = { edit: null, organize: null, run: null } as const;

export const FAILED_RUN_ID = "4f66e011-aaaa-4bbb-8ccc-000000000001";
export const APPROVAL_RUN_ID = "7c1e02aa-aaaa-4bbb-8ccc-000000000002";
const RUNNING_RUN_ID = "a1b2c3d4-aaaa-4bbb-8ccc-000000000003";
export const OK_RUN_ID = "2c6c0c77-aaaa-4bbb-8ccc-000000000004";

export function seededState(): MockState {
  const failed = run({
    attemptsMade: 2,
    automationSlug: "verify-probe",
    deadLetterReason: "retries-exhausted",
    errorCode: "PROCESS_EXIT_NON_ZERO",
    errorMessage: "Automation exited with code 1.",
    finishedAt: ago(4 * MINUTE - 2_000),
    queuedAt: ago(4 * MINUTE),
    runId: FAILED_RUN_ID,
    startedAt: ago(4 * MINUTE),
    status: "dead-lettered",
  });
  const waiting = run({
    approval: {
      assignee: { kind: "user", label: "anna@example.com", userId: "user-anna" },
      details: { message: "Refund 120 € for order 4411?" },
      stepKey: "gate",
    },
    automationSlug: "verify-probe",
    queuedAt: ago(12 * MINUTE),
    runId: APPROVAL_RUN_ID,
    status: "waiting",
    wait: {
      stepKey: "gate",
      reason: "approval",
      assignee: { kind: "user", label: "anna@example.com", userId: "user-anna" },
      details: { message: "Refund 120 € for order 4411?" },
      until: null,
      startedAt: ago(12 * MINUTE),
    },
  });
  const ok = run({
    automationSlug: "verify-probe",
    finishedAt: ago(18 * MINUTE - 400),
    queuedAt: ago(18 * MINUTE),
    runId: OK_RUN_ID,
    startedAt: ago(18 * MINUTE),
    status: "succeeded",
  });
  const running = run({
    automationSlug: "verify-ticker",
    queuedAt: ago(10_000),
    runId: RUNNING_RUN_ID,
    status: "running",
    triggerType: "cron",
  });
  const runs = [running, failed, waiting, ok];

  const automations = [
    automation("verify-probe", {
      description: "Answers the verification webhook and checks the payload.",
      lastRun: failed,
      recentRuns: [failed, waiting, ok].map(glance),
      trigger: trigger({ webhookPath: "/hooks/verify-probe" }),
    }),
    automation("verify-vault", {
      description: "Reads a secret and proves it arrives.",
      requiredSecrets: [
        {
          algorithm: null,
          createdAt: null,
          environment: "staging",
          keyVersion: null,
          name: "VERIFY_SECRET",
          secretVersion: null,
          state: "missing",
          updatedAt: null,
        },
      ],
      trigger: trigger({ webhookPath: "/hooks/verify-vault" }),
    }),
    automation("verify-ticker", {
      description: "Ticks and records the time.",
      lastRun: running,
      recentRuns: [glance(running)],
      trigger: trigger({
        cronIntervalMs: 30_000,
        nextRun: { kind: "at", at: new Date(Date.now() + 18_000).toISOString() },
        triggerType: "cron",
      }),
    }),
    automation("fetch-sales", {
      trigger: trigger({ cronSchedule: "0 6 * * *", triggerType: "cron" }),
    }),
    automation("build-report", {
      trigger: trigger({
        chainOnStatus: "succeeded",
        chainSourceAutomationNames: ["fetch-sales"],
        chainSourceAutomationSlugs: ["fetch-sales"],
        triggerType: "chain",
      }),
    }),
  ];

  const ref = (slug: string) => ({ automationName: slug, automationSlug: slug });
  return {
    automations,
    connections: [],
    needsYou: [
      {
        assignee: { kind: "user", label: "anna@example.com", userId: "user-anna" },
        automation: ref("verify-probe"),
        details: { message: "Refund 120 € for order 4411?" },
        kind: "approval",
        runId: APPROVAL_RUN_ID,
        stepKey: "gate",
        waitUntil: null,
        waitingSince: waiting.queuedAt,
      },
      {
        automation: ref("verify-probe"),
        errorCode: failed.errorCode,
        errorMessage: failed.errorMessage,
        failedRuns: 1,
        kind: "failing",
        lastFailedAt: failed.queuedAt,
        lastFailedRunId: FAILED_RUN_ID,
        lastFailedTriggerType: failed.triggerType,
        recentRuns: 3,
      },
      {
        kind: "missing-secret",
        project: DEFAULT_PROJECT,
        secretName: "VERIFY_SECRET",
        state: "missing",
        usedBy: [ref("verify-vault")],
      },
    ],
    recentChanges: [
      {
        id: "event-1",
        occurredAt: ago(6 * MINUTE),
        actor: { kind: "system" },
        action: "deploy",
        params: {},
        privileged: false,
        status: null,
        details: null,
        requestId: "system",
        target: {
          automationId: "id-verify-probe",
          automationSlug: "verify-probe",
          environment: "staging",
          projectId: PROJECT_ID,
          runId: null,
        },
        automationName: "verify-probe",
        automationSlug: "verify-probe",
        change: {
          kind: "deployment",
          automationId: "id-verify-probe",
          automationSlug: "verify-probe",
          deploymentId: "deployment-verify-probe",
          diff: null,
          environment: "staging",
          eventType: "deploy",
          metadata: {},
          previousDeploymentId: "deployment-old",
          previousSourceHash: "0000",
          previousVersion: "1.0.0",
          projectId: PROJECT_ID,
          sourceHash: "8f1c2a77d3e94b10",
          version: "1.1.0",
        },
      },
    ],
    requests: [],
    runDetails: new Map([
      [
        FAILED_RUN_ID,
        detail(failed, {
          stderr:
            "checking payload for order 4411\nTypeError: Cannot read properties of undefined (reading 'id')\n",
        }),
      ],
      [APPROVAL_RUN_ID, detail(waiting)],
      [OK_RUN_ID, detail(ok, { result: { refunded: false } })],
      [RUNNING_RUN_ID, detail(running)],
    ]),
    automationRefusals: NO_REFUSALS,
    deploy: null,
    folders: { create: null, folders: [] },
    projects: [DEFAULT_PROJECT],
    runs,
    secrets: [],
    tokens: [],
    unhandled: [],
  };
}

/** A fresh instance: signed in, nothing deployed. */
export function emptyState(): MockState {
  return {
    automations: [],
    connections: [],
    needsYou: [],
    automationRefusals: NO_REFUSALS,
    deploy: null,
    folders: { create: null, folders: [] },
    projects: [DEFAULT_PROJECT],
    recentChanges: [],
    requests: [],
    runDetails: new Map(),
    runs: [],
    secrets: [],
    tokens: [],
    unhandled: [],
  };
}

// What verify-probe ships: a flowchart whose node ids are its step names, and the entrypoint the
// API scanned for those steps, with the line each one spans.
const PROBE_FLOW = `flowchart LR
  start([Webhook]) --> fetch[Fetch order]
  fetch --> gate{Approve refund?}
  gate -->|yes| notify[Notify finance]
  gate -->|no| done([Done])
  notify --> done
`;

const PROBE_SOURCE = `const { runStep, requestApproval } = require("./swizzle-sdk");

async function main(payload) {
  const order = await runStep("fetch", async () => ({ id: payload.order }));
  const approved = await requestApproval("gate", {
    message: \`Refund 120 € for order \${order.id}?\`,
  });
  if (approved) {
    await runStep("notify", async () => true);
  }
  return { refunded: approved };
}
`;

const PROBE_STEPS = [
  { endLine: 4, key: "fetch", kind: "step", startLine: 4, target: null },
  { endLine: 7, key: "gate", kind: "approval", startLine: 5, target: null },
  { endLine: 9, key: "notify", kind: "step", startLine: 9, target: null },
] as const;

const PERSON = {
  createdAt: ago(30 * 24 * 60 * MINUTE),
  email: "ada@example.com",
  id: "person-1",
  name: "Ada",
  role: "member",
  suspended: false,
  twoFactorEnabled: false,
} as const;

/** Answers every `/api` request of `page` from `state`. */
/**
 * A person with two-factor sign-in on: the password step answers with a challenge, and the code
 * step accepts `totp` at /verify-totp and `recoveryCode` at /verify-backup-code. With
 * `expireFirstChallenge`, the first code arrives after the challenge ran out.
 */
export interface MockTwoFactor {
  readonly expireFirstChallenge?: boolean;
  readonly recoveryCode: string;
  readonly totp: string;
}

export async function mockDashboardApi(
  page: Page,
  state: MockState,
  options: { readonly authenticated?: boolean; readonly twoFactor?: MockTwoFactor } = {},
) {
  let authenticated = options.authenticated !== false;
  let challenged = false;
  let challengeExpires = options.twoFactor?.expireFirstChallenge === true;
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname.replace(/^\/api/u, "");
      const method = request.method();
      const body = request.postData() === null ? null : (request.postDataJSON() as unknown);
      state.requests.push({ body, method, pathname, search: url.searchParams });
      const is = (verb: string, pattern: RegExp) => method === verb && pattern.test(pathname);
      const param = (pattern: RegExp) => decodeURIComponent(pattern.exec(pathname)?.[1] ?? "");
      // As the API: the named project, `default` when the request names none.
      const requestedProject = () => {
        const project = url.searchParams.get("project") ?? "default";
        return project === "default" ? PROJECT_ID : project;
      };

      if (is("GET", /^\/auth\/status$/u)) {
        return json(route, {
          authenticated,
          setupRequired: false,
          setupTokenRequired: false,
          user: authenticated ? PERSON : null,
        });
      }
      if (is("POST", /^\/auth\/sign-in\/email$/u)) {
        if (options.twoFactor !== undefined) {
          challenged = true;
          return json(route, { twoFactorRedirect: true } satisfies SignInResponse);
        }
        authenticated = true;
        return json(route, { user: PERSON } satisfies SignInResponse);
      }
      if (is("POST", /^\/auth\/two-factor\/verify-(totp|backup-code)$/u)) {
        const expected = pathname.endsWith("totp")
          ? options.twoFactor?.totp
          : options.twoFactor?.recoveryCode;
        if (!challenged || challengeExpires) {
          challenged = false;
          challengeExpires = false;
          return apiError(route, "AUTH_CODE_CHALLENGE_EXPIRED", 401, "Sign in again.");
        }
        if ((body as { code?: string } | null)?.code !== expected) {
          return apiError(route, "AUTH_CODE_INVALID", 401, "Invalid code.");
        }
        challenged = false;
        authenticated = true;
        return json(route, { user: PERSON });
      }
      if (is("POST", /^\/auth\/sign-out$/u)) {
        authenticated = false;
        return json(route, { success: true });
      }
      if (!authenticated) return apiError(route, "UNAUTHORIZED", 401, "Sign in.");

      if (is("GET", /^\/environments$/u)) {
        return json(route, {
          defaultEnvironment: "staging",
          environments: [{ name: "staging" }, { name: "production" }],
        });
      }
      if (is("GET", /^\/dashboard\/overview$/u)) {
        const counts = {
          "dead-lettered": 0,
          failed: 0,
          queued: 0,
          running: 0,
          succeeded: 0,
          waiting: 0,
        };
        for (const item of state.runs) counts[item.status] += 1;
        return json(route, {
          deploy: state.deploy,
          environment: "staging",
          last24h: counts,
          complete: true,
          needsYou: state.needsYou,
          recentChanges: state.recentChanges,
        } satisfies Overview);
      }
      if (is("GET", /^\/dashboard\/automations$/u)) {
        return json(route, { automations: state.automations, environment: "staging" });
      }
      if (is("GET", /^\/dashboard\/automations\/[^/]+$/u)) {
        const found = state.automations.find(
          (item) => item.automationSlug === param(/^\/dashboard\/automations\/([^/]+)$/u),
        );
        if (found === undefined)
          return apiError(route, "AUTOMATION_NOT_FOUND", 404, "No such automation.");
        return json(route, {
          ...found,
          deploymentAudit: [],
          deploymentHistory: [found.activeDeployment],
          refusals: state.automationRefusals,
        } satisfies AutomationDetail);
      }
      if (is("GET", /^\/dashboard\/automations\/verify-probe\/mermaid$/u)) {
        return json(route, {
          automationSlug: "verify-probe",
          available: true,
          content: PROBE_FLOW,
          environment: "staging",
          error: null,
          filePath: "flow.mermaid",
        });
      }
      if (is("GET", /^\/dashboard\/automations\/[^/]+\/(readme|mermaid)$/u)) {
        return json(route, {
          automationSlug: "",
          available: false,
          content: null,
          environment: "staging",
          error: null,
          filePath: null,
        });
      }
      if (is("GET", /^\/automation-folders$/u)) return json(route, state.folders);
      if (is("GET", /^\/dashboard\/runs$/u)) {
        const statuses = url.searchParams.get("status")?.split(",") ?? [];
        const slug = url.searchParams.get("automation");
        const parent = url.searchParams.get("parentRunId");
        const topLevelOnly = url.searchParams.get("topLevelOnly") === "true";
        const approvalOnly = url.searchParams.get("approvalOnly") === "true";
        const runs = state.runs.filter(
          (item) =>
            (statuses.length === 0 || statuses.includes(item.status)) &&
            (slug === null || item.automationSlug === slug) &&
            (parent === null || item.parentRunId === parent) &&
            (!topLevelOnly || item.parentRunId === null) &&
            (!approvalOnly || item.approval !== null),
        );
        return json(route, { environment: "staging", filters: {}, runs });
      }
      if (is("GET", /^\/dashboard\/runs\/[^/]+$/u)) {
        const found = state.runDetails.get(param(/^\/dashboard\/runs\/([^/]+)$/u));
        return found === undefined
          ? apiError(route, "RUN_NOT_FOUND", 404, "No such run.")
          : json(route, found);
      }
      if (is("GET", /^\/dashboard\/runs\/[^/]+\/steps$/u)) {
        const runId = param(/^\/dashboard\/runs\/([^/]+)\//u);
        const run = state.runDetails.get(runId);
        if (run?.automationSlug !== "verify-probe" || run.status === "dead-lettered") {
          return json(route, []);
        }
        // The fetch step ran in the first 400 ms of every probe run; notify only when it finished.
        const startedAt = run.startedAt ?? run.queuedAt;
        const at = (ms: number) => new Date(Date.parse(startedAt) + ms).toISOString();
        const step = (
          stepKey: string,
          from: number,
          to: number,
          approval: RunStep["approval"] = null,
        ): RunStep => ({
          approval,
          attempt: 1,
          executionNumber: 1,
          createdAt: at(from),
          finishedAt: at(to),
          startedAt: at(from),
          stepKey,
          updatedAt: at(to),
          value: null,
        });
        const decided: RunStep["approval"] = {
          approved: true,
          assignee: { kind: "user", label: "anna@example.com", userId: "user-anna" },
          comment: "Looks right",
          decidedAt: at(5_000),
          decidedBy: { kind: "person", label: "anna@example.com", userId: "user-anna" },
          timedOut: false,
        };
        return json(
          route,
          run.status === "succeeded"
            ? [
                step("fetch", 20, 400),
                step("gate", 400, 5_000, decided),
                step("notify", 5_000, 5_300),
              ]
            : [step("fetch", 20, 400)],
        );
      }
      if (is("GET", /^\/dashboard\/automations\/[^/]+\/source$/u)) {
        const slug = param(/^\/dashboard\/automations\/([^/]+)\//u);
        return json(route, {
          automationSlug: slug,
          content: slug === "verify-probe" ? PROBE_SOURCE : null,
          deploymentId: url.searchParams.get("deployment") ?? "deployment-1",
          entrypoint: "main.js",
          error: slug === "verify-probe" ? null : "The entrypoint is missing.",
          language: "node",
          steps: slug === "verify-probe" ? PROBE_STEPS : [],
        });
      }
      if (is("GET", /^\/dashboard\/automations\/[^/]+\/step-reach$/u)) {
        return json(route, { reached: { fetch: 3, gate: 2, notify: 1 }, runs: 3 });
      }
      if (is("GET", /^\/runs\/[^/]+\/diagnosis$/u)) {
        return json(route, {
          likelyCause: {
            code: "AUTOMATION_CRASHED",
            summary: "Automation process exited non-zero. Inspect stderr for the root cause.",
          },
          suggestedFixes: [],
        });
      }
      if (is("GET", /^\/runs\/[^/]+\/logs\/stream$/u)) {
        return route.fulfill({
          body: 'event: status\ndata: {"status":"running","terminal":false}\n\n',
          contentType: "text/event-stream",
        });
      }
      if (is("PUT", /^\/runs\/[^/]+\/approvals\/[^/]+\/assignee$/u)) {
        const runId = param(/^\/runs\/([^/]+)\//u);
        const assignee = { kind: "team" as const, label: "Finance", teamId: "team-finance" };
        const run = state.runDetails.get(runId);
        if (run?.approval)
          state.runDetails.set(runId, { ...run, approval: { ...run.approval, assignee } });
        return json(route, { assignee, runId, stepKey: "gate" });
      }
      if (is("POST", /^\/runs\/[^/]+\/approvals\/[^/]+$/u)) {
        const runId = param(/^\/runs\/([^/]+)\//u);
        state.needsYou = state.needsYou.filter(
          (item) => !(item.kind === "approval" && item.runId === runId),
        );
        const resumed = {
          approval: null,
          status: "queued" as const,
          wait: null,
        };
        state.runs = state.runs.map((item) =>
          item.runId === runId ? { ...item, ...resumed } : item,
        );
        const run = state.runDetails.get(runId);
        if (run !== undefined) state.runDetails.set(runId, { ...run, ...resumed });
        return json(route, { resumed: true, runId });
      }
      if (is("GET", /^\/projects$/u)) return json(route, { projects: state.projects });
      if (is("GET", /^\/secrets$/u))
        return json(route, { environment: "staging", secrets: state.secrets });
      if (is("PUT", /^\/secrets\/[^/]+$/u)) {
        const name = param(/^\/secrets\/([^/]+)$/u);
        const projectId = requestedProject();
        const { slug, name: projectName } =
          state.projects.find((project) => project.id === projectId) ?? DEFAULT_PROJECT;
        const secret: SecretMetadata = {
          algorithm: "aes-256-gcm",
          createdAt: ago(0),
          environment: "staging",
          id: `secret-${projectId}-${name}`,
          keyVersion: "v1",
          name,
          project: { id: projectId, name: projectName, slug },
          projectId,
          right: "manage",
          secretVersion: 1,
          updatedAt: ago(0),
        };
        const same = (item: { readonly name: string; readonly projectId: string }) =>
          item.name === name && item.projectId === projectId;
        state.secrets = [...state.secrets.filter((item) => !same(item)), secret];
        // The deployment bound the secret it lost, so the new one waits for the next deploy.
        state.needsYou = state.needsYou.map((item) =>
          item.kind === "missing-secret" &&
          item.secretName === name &&
          item.project.id === projectId
            ? { ...item, state: "unbound" }
            : item,
        );
        state.automations = state.automations.map((item) =>
          item.projectId !== projectId
            ? item
            : {
                ...item,
                requiredSecrets: item.requiredSecrets.map((required) =>
                  required.name === name && required.state === "missing"
                    ? { ...required, state: "unbound" }
                    : required,
                ),
              },
        );
        return json(route, secret);
      }
      if (is("GET", /^\/connections$/u)) {
        return json(route, {
          connections: state.connections,
          environment: "staging",
          redirectBaseUrl: "https://swizzle.example.com",
        });
      }
      if (is("POST", /^\/connections\/[^/]+\/authorize$/u)) {
        const name = param(/^\/connections\/([^/]+)\/authorize$/u);
        const projectId = requestedProject();
        const input = body as { readonly clientId?: string; readonly provider?: string };
        const connection: ListedConnection = {
          accessTokenExpiresAt: null,
          authorizationPending: true,
          clientId: input.clientId ?? "",
          createdAt: ago(0),
          environment: "staging",
          id: `connection-${projectId}-${name}`,
          lastErrorAt: null,
          lastErrorCode: null,
          lastRefreshedAt: null,
          name,
          project: state.projects.find((project) => project.id === projectId) ?? DEFAULT_PROJECT,
          provider: input.provider ?? "google",
          right: "manage",
          scopes: [],
          status: "pending",
          tokenVersion: 0,
          updatedAt: ago(0),
        };
        state.connections = [
          ...state.connections.filter(
            (item) => !(item.name === name && item.project.id === projectId),
          ),
          connection,
        ];
        return json(route, {
          authorizationUrl: `https://accounts.example.com/consent?connection=${name}`,
          connection,
          expiresAt: ago(-10 * MINUTE),
          redirectUri: `https://swizzle.example.com/oauth/callback/${connection.provider}`,
        });
      }
      if (is("GET", /^\/auth\/tokens$/u)) return json(route, { tokens: state.tokens });
      if (is("POST", /^\/auth\/tokens$/u)) {
        const input = body as {
          readonly expiresAt: string;
          readonly name: string;
          readonly scope?: ScopeInput;
        };
        const id = `token-${state.tokens.length + 1}`;
        // As the API: an omitted field limits nothing, and projects come back by name.
        const projects =
          input.scope?.projects?.map((slug) => ({ id: PROJECT_ID, name: "Default", slug })) ?? null;
        const token: TokenResponse = {
          createdAt: ago(0),
          expiresAt: input.expiresAt,
          id,
          issuedBy: null,
          lastUsedAt: null,
          name: input.name,
          revokedAt: null,
          scope: {
            environments: input.scope?.environments ?? null,
            projects,
            role: input.scope?.role ?? "admin",
          },
          tokenPrefix: "swz_",
        };
        state.tokens = [...state.tokens, token];
        return json(route, {
          ...token,
          token: `swz_${id}_one-time-plaintext`,
        } satisfies CreatedApiToken);
      }
      if (is("DELETE", /^\/auth\/tokens\/([^/]+)$/u)) {
        const id = param(/^\/auth\/tokens\/([^/]+)$/u);
        state.tokens = state.tokens.map((token) =>
          token.id === id ? { ...token, revokedAt: ago(0) } : token,
        );
        const revoked = state.tokens.find((token) => token.id === id);
        if (revoked === undefined)
          return apiError(route, "API_TOKEN_NOT_FOUND", 404, "No such token.");
        return json(route, revoked);
      }
      if (is("GET", /^\/auth\/sessions$/u)) return json(route, { sessions: [] });
      if (is("GET", /^\/auth\/two-factor$/u)) return json(route, { enabled: false });
      if (is("GET", /^\/notifications\/(rules|deliveries)$/u)) {
        return json(route, { deliveries: [], environment: "staging", rules: [] });
      }
      if (is("GET", /^\/ops\/summary$/u)) {
        return json(route, {
          maintenance: { latestRun: null, staleAfterMs: 0, state: "healthy" },
          onlineWorkers: 1,
          services: {
            heartbeatTtlMs: 30_000,
            instances: [],
            summary: [{ alive: 1, service: "scheduler", stale: 0, total: 1 }],
          },
        });
      }
      if (is("GET", /^\/health$/u))
        return json(route, { service: "api", status: "ok", version: "0.9.0" });

      state.unhandled.push(`${method} ${pathname}`);
      // The mock's own signal, deliberately no API code: a flow that reaches it missed a route.
      return json(
        route,
        { error: "NOT_MOCKED", message: `${method} ${pathname} is not mocked.` },
        404,
      );
    },
  );
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: "application/json", status });
}

/** An error body as the API sends it, with a code and status the shared catalogue pairs. */
function apiError<Code extends ApiErrorCode>(
  route: Route,
  code: Code,
  status: (typeof API_ERROR_STATUS)[Code],
  message: string,
) {
  return json(route, { code, error: code, message } satisfies ApiErrorResponse, status);
}
