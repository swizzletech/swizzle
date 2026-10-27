import { checkNeedsAttention } from "./api-check-rules.js";
import type {
  PlatformRunStatus,
  StoredMaintenanceRun,
  StoredNotificationDelivery,
} from "./control-plane-types.js";
import type {
  DashboardAttentionItem,
  DashboardAutomationRef,
  DashboardAutomationSummary,
  DashboardQueuedRuns,
  DashboardQueueSummary,
} from "./dashboard-types.js";
import { isFinishedRun } from "./run-status.js";
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
  /** The automations whose own rows Needs you raises: on the Overview, those its reader may edit. */
  readonly automations: readonly DashboardAutomationSummary[];
  readonly deliveries: readonly StoredNotificationDelivery[];
  /** The environment the Overview shows. */
  readonly environment: string;
  /** The environments a live scheduler serves, judged by the API. */
  readonly schedulerEnvironments: ReadonlySet<string>;
  /** The environment's queued runs with their placement against `workers`. */
  readonly queued: readonly (DashboardQueuedRuns & { readonly placement: RunPlacement })[];
  readonly latestMaintenanceRun: StoredMaintenanceRun | null;
  readonly observedAt: Date;
  /** Null when the queue could not be read. */
  readonly queueCounts: DashboardQueueSummary["counts"] | null;
  /** The unrevoked workers that reach the environment. */
  readonly workers: readonly Pick<WorkerStatus, "name" | "state" | "runImageDiskOverBudget">[];
}

/**
 * The Needs you items only an instance owner or admin acts on: the instance's own problems, and
 * runs that wait for a worker, which only they grant or bring online.
 */
export const INSTANCE_ATTENTION: ReadonlySet<DashboardAttentionItem["kind"]> = new Set([
  "notifications-failed",
  "platform",
  "waiting-for-worker",
]);

const FAILED_STATUSES: ReadonlySet<PlatformRunStatus> = new Set(["failed", "dead-lettered"]);
/** The waits only the owner ends: no worker granted, none online, or its service unhealthy. */
const UNPLACED: ReadonlySet<PlacementWait> = new Set(["no-worker", "offline", "service-unhealthy"]);

/**
 * The Overview's "Needs you": what waits for the owner, in the order the page lists it. Approvals
 * first, then failing automations, then what blocks an automation, then API warnings, then
 * platform problems. Without automations or queued runs only approvals show, so a fresh
 * instance never reads as a fault.
 */
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
    // A run still in flight says nothing yet, so it must not hide the failure before it.
    const latest = automation.recentRuns.find((run) => isFinishedRun(run.status));
    if (latest !== undefined && FAILED_STATUSES.has(latest.status)) {
      items.push({
        automation: refOf(automation),
        errorCode: latest.errorCode,
        errorMessage: latest.errorMessage,
        failedRuns: automation.recentRuns.filter((run) => FAILED_STATUSES.has(run.status)).length,
        kind: "failing",
        lastFailedAt: latest.queuedAt,
        lastFailedRunId: latest.runId,
        recentRuns: automation.recentRuns.length,
      });
    }
  }

  // By project and name: each project holds its own secret of a name.
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
        // The project decides the state, so every automation of one key shares it.
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
        // Deployments of one project can differ: an older one lost the connection it bound while a
        // newer one bound its replacement, so each status gets its own row.
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
  // Runs no worker can take now wait out their deadline unless the owner acts; a busy group or a
  // worker about to pull clears by itself.
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
    const disk = worker.runImageDiskOverBudget;
    if (disk !== null) {
      items.push({
        kind: "platform",
        problem: {
          code: "run-image-disk",
          worker: worker.name,
          warning: runImageDiskWarning(worker.name, disk),
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

/**
 * An automation's API warnings, distinct from failed runs: a check that found drift or could not
 * decide 3 times in a row, a sunset notice its runs saw within 7 days that is due within 90 days
 * or a deprecation already in effect, and a passive automation that has not reached its API
 * for longer than its threshold. An automation with `api_check: off` shows only sunset notices.
 */
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
    const latest = automation.recentRuns.find((run) => isFinishedRun(run.status));
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
