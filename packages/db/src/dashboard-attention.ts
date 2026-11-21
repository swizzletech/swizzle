import { checkNeedsAttention } from "./api-check-rules.js";
import type { StoredMaintenanceRun, StoredNotificationDelivery } from "./control-plane-types.js";
import type {
  DashboardAttentionItem,
  DashboardAutomationRef,
  DashboardAutomationSummary,
  DashboardQueuedRuns,
  DashboardQueueSummary,
  DashboardRunGlance,
} from "./dashboard-types.js";
import { isFailedState, isFinishedRun } from "./run-status.js";
import { placementInWords, runImageDiskWarning } from "./worker-words.js";
import type { PlacementWait, RunPlacement, WorkerStatus } from "./workers.js";

const DAY_MS = 24 * 60 * 60_000;
const QUEUE_BACKLOG_THRESHOLD = 10;
const DEFAULT_MAINTENANCE_STALE_MS = 5 * 60_000;
export interface BuildAttentionInput {
  readonly approvals: readonly Omit<
    Extract<DashboardAttentionItem, { kind: "approval" }>,
    "kind"
  >[];
  readonly automations: readonly DashboardAutomationSummary[];
  readonly deliveries: readonly StoredNotificationDelivery[];
  readonly environment: string;
  readonly schedulerEnvironments: ReadonlySet<string>;
  readonly queued: readonly (DashboardQueuedRuns & { readonly placement: RunPlacement })[];
  readonly latestMaintenanceRun: StoredMaintenanceRun | null;
  readonly observedAt: Date;
  readonly queueCounts: DashboardQueueSummary["counts"] | null;
  readonly workers: readonly Pick<WorkerStatus, "name" | "state" | "runImageDiskOverBudget">[];
}

export const INSTANCE_ATTENTION: ReadonlySet<DashboardAttentionItem["kind"]> = new Set([
  "notifications-failed",
  "platform",
  "waiting-for-worker",
]);

const UNPLACED: ReadonlySet<PlacementWait> = new Set(["no-worker", "offline", "service-unhealthy"]);

function latestResult(automation: DashboardAutomationSummary): DashboardRunGlance | undefined {
  return automation.recentRuns.find(
    (run) => isFinishedRun(run.status) && run.state !== "cancelled",
  );
}

export function buildAttention(input: BuildAttentionInput): readonly DashboardAttentionItem[] {
  const items: DashboardAttentionItem[] = input.approvals
    .toSorted((left, right) => left.waitingSince.localeCompare(right.waitingSince))
    .map((approval) => ({ kind: "approval", ...approval }));
  if (input.automations.length === 0 && input.queued.length === 0) {
    return items;
  }
  const refOf = (automation: DashboardAutomationSummary): DashboardAutomationRef => ({
    automationName: automation.automationName,
    automationSlug: automation.automationSlug,
  });

  for (const automation of input.automations) {
    const latest = latestResult(automation);
    if (latest !== undefined && isFailedState(latest.state)) {
      items.push({
        automation: refOf(automation),
        errorCode: latest.errorCode,
        errorMessage: latest.errorMessage,
        failedRuns: automation.recentRuns.filter((run) => isFailedState(run.state)).length,
        kind: "failing",
        lastFailedAt: latest.queuedAt,
        lastFailedRunId: latest.runId,
        lastFailedTriggerType: latest.triggerType,
        recentRuns: automation.recentRuns.length,
      });
    }
  }

  const missingSecrets = new Map<
    string,
    Omit<Extract<DashboardAttentionItem, { kind: "missing-secret" }>, "kind">
  >();
  const brokenConnections = new Map<
    string,
    Omit<Extract<DashboardAttentionItem, { kind: "missing-connection" }>, "kind">
  >();
  for (const automation of input.automations) {
    for (const secret of automation.requiredSecrets) {
      if (secret.state !== "bound") {
        const key = JSON.stringify([automation.projectId, secret.name]);
        const known = missingSecrets.get(key);
        missingSecrets.set(key, {
          project: automation.project,
          secretName: secret.name,
          state: secret.state,
          usedBy: [...(known?.usedBy ?? []), refOf(automation)],
        });
      }
    }
    for (const connection of automation.requiredConnections) {
      if (connection.status !== "active") {
        const key = JSON.stringify([automation.projectId, connection.name, connection.status]);
        const known = brokenConnections.get(key);
        brokenConnections.set(key, {
          connectionName: connection.name,
          project: automation.project,
          provider: connection.provider,
          status: connection.status,
          usedBy: [...(known?.usedBy ?? []), refOf(automation)],
        });
      }
    }
  }
  for (const missing of missingSecrets.values()) {
    items.push({ kind: "missing-secret", ...missing });
  }
  for (const broken of brokenConnections.values()) {
    items.push({ kind: "missing-connection", ...broken });
  }
  for (const automation of input.automations) {
    if (automation.trigger?.status === "invalid") {
      items.push({
        automation: refOf(automation),
        kind: "trigger-invalid",
        message: automation.trigger.errorMessage,
      });
    }
  }
  for (const queued of input.queued) {
    if (!UNPLACED.has(queued.placement.wait)) continue;
    items.push({
      automation: queued.automation,
      deadline: queued.deadline,
      group: queued.placement.group,
      kind: "waiting-for-worker",
      queuedRuns: queued.queued,
      reason: placementInWords(queued.placement, queued).reason,
      runId: queued.runId,
    });
  }
  const apiItems = input.automations.flatMap((automation) =>
    apiAttention(automation, refOf(automation), input.observedAt),
  );
  for (const kind of ["api-check", "api-sunset", "api-untested"] as const) {
    items.push(...apiItems.filter((item) => item.kind === kind));
  }

  const workerAlive = input.workers.some((worker) => worker.state === "online");
  if (input.queueCounts === null) {
    items.push({ kind: "platform", problem: { code: "queue-unreachable" } });
  }
  if (!workerAlive) {
    items.push({
      kind: "platform",
      problem: { code: "no-worker", queuedRuns: input.queueCounts?.waiting ?? 0 },
    });
  } else if (input.queueCounts !== null && input.queueCounts.waiting >= QUEUE_BACKLOG_THRESHOLD) {
    items.push({
      kind: "platform",
      problem: { code: "queue-backlog", waitingJobs: input.queueCounts.waiting },
    });
  }
  const served = input.schedulerEnvironments;
  if (!served.has(input.environment)) {
    items.push({
      kind: "platform",
      problem: {
        code: "scheduler-down",
        environment: input.environment,
        served: [...served].toSorted(),
      },
    });
  }
  const maintenance = input.latestMaintenanceRun;
  if (
    maintenance !== null &&
    (maintenance.status === "failed" ||
      input.observedAt.getTime() - Date.parse(maintenance.startedAt) > DEFAULT_MAINTENANCE_STALE_MS)
  ) {
    items.push({
      kind: "platform",
      problem: { code: "maintenance-failing", lastRunAt: maintenance.startedAt },
    });
  }
  for (const worker of input.workers) {
    const warning = runImageDiskWarning(worker.name, worker.runImageDiskOverBudget);
    if (warning !== null) {
      items.push({
        kind: "platform",
        problem: {
          code: "run-image-disk",
          worker: worker.name,
          warning,
        },
      });
    }
  }

  const failedDeliveries = input.deliveries.filter(
    (delivery) =>
      delivery.status === "failed" &&
      input.observedAt.getTime() - Date.parse(delivery.createdAt) <= DAY_MS,
  );
  const lastFailed = failedDeliveries.toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0];
  if (lastFailed !== undefined) {
    items.push({
      failed: failedDeliveries.length,
      kind: "notifications-failed",
      lastError: lastFailed.errorMessage,
      lastFailedAt: lastFailed.createdAt,
    });
  }
  return items;
}

const SUNSET_WINDOW_MS = 90 * DAY_MS;
const NOTICE_FRESH_MS = 7 * DAY_MS;

function apiAttention(
  automation: DashboardAutomationSummary,
  automationRef: DashboardAutomationRef,
  observedAt: Date,
): DashboardAttentionItem[] {
  const now = observedAt.getTime();
  const items: DashboardAttentionItem[] = [];
  const apiCheck = automation.apiCheck;
  if (
    apiCheck?.mode === "active" &&
    apiCheck.record !== null &&
    checkNeedsAttention(apiCheck.record)
  ) {
    const latest = latestResult(automation);
    items.push({
      automation: automationRef,
      change:
        apiCheck.record.status === "drift" ? (apiCheck.record.lastReport?.change ?? null) : null,
      check: { ...apiCheck.record, entrypoint: apiCheck.entrypoint, everyMs: apiCheck.everyMs },
      kind: "api-check",
      latestRun: latest === undefined ? null : { queuedAt: latest.queuedAt, status: latest.status },
    });
  }
  for (const contact of automation.apiContacts) {
    const fresh =
      contact.noticeSeenAt !== null && now - Date.parse(contact.noticeSeenAt) <= NOTICE_FRESH_MS;
    const due =
      (contact.sunsetAt !== null && Date.parse(contact.sunsetAt) - now <= SUNSET_WINDOW_MS) ||
      (contact.deprecatedAt !== null && Date.parse(contact.deprecatedAt) <= now);
    if (fresh && due) {
      items.push({ apiCheck, automation: automationRef, contact, kind: "api-sunset" });
    }
  }
  if (apiCheck?.mode === "passive") {
    const last = automation.apiContacts[0];
    const since = last?.lastContactAt ?? automation.activeDeployment.deployedAt;
    if (now - Date.parse(since) > apiCheck.untestedAfterMs) {
      items.push({
        automation: automationRef,
        host: last?.host ?? null,
        kind: "api-untested",
        since,
        thresholdMs: apiCheck.untestedAfterMs,
      });
    }
  }
  return items;
}
