import type {
  AutomationDetail,
  AutomationSummary,
  RunListItem,
  TriggerSummary,
} from "../../src/lib/api";
import { DEFAULT_PROJECT, PROJECT_ID } from "./projects";
import type { MockRoute } from "./route";
import { ago, MINUTE } from "./route";
import type { MockState } from "./state";

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
    state: item.state,
    status: item.status,
    triggerType: item.triggerType,
  };
}

export const NO_REFUSALS = { edit: null, organize: null, run: null } as const;

export function seedAutomations({
  failed,
  waiting,
  ok,
  running,
}: {
  readonly failed: RunListItem;
  readonly waiting: RunListItem;
  readonly ok: RunListItem;
  readonly running: RunListItem;
}): AutomationSummary[] {
  return [
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
}

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

export function automations({ apiError, is, json, param, search }: MockRoute, state: MockState) {
  if (is("GET", /^\/dashboard\/automations$/u)) {
    return json({ automations: state.automations, environment: "staging" });
  }
  if (is("GET", /^\/dashboard\/automations\/[^/]+$/u)) {
    const found = state.automations.find(
      (item) => item.automationSlug === param(/^\/dashboard\/automations\/([^/]+)$/u),
    );
    if (found === undefined) return apiError("AUTOMATION_NOT_FOUND", 404, "No such automation.");
    return json({
      ...found,
      deploymentAudit: [],
      deploymentHistory: [found.activeDeployment],
      refusals: state.automationRefusals,
    } satisfies AutomationDetail);
  }
  if (is("GET", /^\/dashboard\/automations\/verify-probe\/mermaid$/u)) {
    return json({
      automationSlug: "verify-probe",
      available: true,
      content: PROBE_FLOW,
      environment: "staging",
      error: null,
      filePath: "flow.mermaid",
    });
  }
  if (is("GET", /^\/dashboard\/automations\/verify-probe\/readme$/u)) {
    return json({
      automationSlug: "verify-probe",
      available: false,
      content: null,
      environment: "staging",
      error: null,
      filePath: null,
    });
  }
  if (is("GET", /^\/dashboard\/automations\/verify-probe\/source$/u)) {
    return json({
      automationSlug: "verify-probe",
      content: PROBE_SOURCE,
      deploymentId: search.get("deployment") ?? "deployment-1",
      entrypoint: "main.js",
      error: null,
      language: "node",
      steps: PROBE_STEPS,
    });
  }
  if (is("GET", /^\/dashboard\/automations\/verify-probe\/step-reach$/u)) {
    return json({ reached: { fetch: 3, gate: 2, notify: 1 }, runs: 3 });
  }
  return undefined;
}
