import { stepSourceLanguage } from "@swizzle/config";
import type {
  AccessTarget,
  DashboardAutomationDetail,
  DashboardAutomationReadme,
  DashboardAutomationSource,
  DashboardAutomationSummary,
  DashboardDeploymentSummary,
  DashboardMermaidDiagram,
  DashboardOperabilitySummary,
  DashboardOperationsSummary,
  DashboardOverview,
  DashboardQueueSummary,
  DashboardRunListItem,
  DashboardRunStep,
  DashboardRunsQuery,
  DashboardRunsResult,
  DashboardServiceHeartbeatView,
  DashboardStepReach,
  DashboardStore,
  ReadScope,
  RunApproval,
  Subject,
  WorkerRegistry,
  WorkerStatus,
} from "@swizzle/db";
import {
  buildAttention,
  explainPlacement,
  INSTANCE_ATTENTION,
  workerReachesEnvironment,
} from "@swizzle/db";
import { createDashboardStore } from "@swizzle/db/postgres";
import {
  addCredentialIssues,
  createArtifactStorageForReference,
  createQueueNameForProfile,
  evaluateAutomationReadiness,
  type RuntimeReadinessReport,
  servesProject,
} from "@swizzle/runtime";
import type {
  CronNextRun,
  JudgedAutomationDetail,
  JudgedAutomationSummary,
  JudgedTriggerSummary,
} from "@swizzle/runtime/http-contract";
import type {
  PlatformMaintenanceRunRecord,
  PlatformNotificationDeliveryRecord,
  PlatformServices,
} from "@swizzle/runtime/platform";
import {
  listRegisteredReadinessWorkers,
  type RegisteredReadinessWorker,
} from "@swizzle/runtime/platform";
import { Queue } from "bullmq";

const DEFAULT_HEARTBEAT_TTL_MS = 30_000;
const DEFAULT_MAINTENANCE_STALE_MS = 5 * 60_000;
/**
 * Only surface a stale-service alert for heartbeats that fell silent recently.
 * Older rows are decommissioned/forgotten services (the retention job will
 * remove them eventually) and must not keep the platform pinned to `degraded`.
 */
const DEFAULT_STALE_ALERT_WINDOW_MS = 15 * 60_000;
const DEFAULT_QUEUE_NAME = createQueueNameForProfile("host-default");
const DEFAULT_VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const DAY_MS = 24 * 60 * 60_000;
/** How many of an automation's latest runs the static track counts reach over. */
const STEP_REACH_RUNS = 50;
/** Who looks at the Overview: what Needs you lists depends on what they may act on. */
interface OverviewViewer {
  /** The person and their teams, whose assigned approvals they may decide. */
  readonly subjects: readonly Subject[];
  mayDecide(run: DashboardRunListItem, approval: RunApproval): Promise<boolean>;
  /** Whether they may change the automation here: fix its code, trigger or credentials. */
  mayEdit(automation: AccessTarget): Promise<boolean>;
  /** Whether they operate the instance, so grant workers and act on its problems. */
  readonly operatesInstance: boolean;
}

/** The automation's detail before its route adds what the viewer's role refuses. */

export interface DashboardDataProvider {
  close(): Promise<void>;
  /** The automation, naming among what it invokes only what `scope` lets the viewer read. */
  getAutomationDetail(
    automationSlug: string,
    environment: string,
    scope: ReadScope,
  ): Promise<JudgedAutomationDetail | null>;
  getAutomationReadme(
    automationSlug: string,
    environment: string,
  ): Promise<DashboardAutomationReadme | null>;
  /** The flow.mermaid of the active deployment, or of `deploymentId` when it is one of this automation's. */
  getMermaidDiagram(
    automationSlug: string,
    environment: string,
    deploymentId?: string,
  ): Promise<DashboardMermaidDiagram | null>;
  /** The entrypoint of the active deployment, or of `deploymentId` when it is one of this automation's. */
  getAutomationSource(
    automationSlug: string,
    environment: string,
    deploymentId?: string,
  ): Promise<DashboardAutomationSource | null>;
  getStepReach(automationSlug: string, environment: string): Promise<DashboardStepReach | null>;
  getOperationsSummary(environment: string): Promise<DashboardOperationsSummary>;
  /**
   * The Overview's read model: 24 h counts, Needs you and Recently changed, over the automations
   * in `scope`. Platform and notification problems and runs waiting for a worker need an instance
   * owner or admin, so only a viewer who operates the instance sees them. Needs you lists the
   * approvals the viewer may decide, and what an automation needs fixed only where the viewer may
   * edit it.
   */
  getOverview(
    environment: string,
    scope: ReadScope,
    viewer: OverviewViewer,
  ): Promise<DashboardOverview>;
  getOperabilitySummary(environment: string): Promise<DashboardOperabilitySummary>;
  listAutomations(
    environment: string,
    scope: ReadScope,
  ): Promise<readonly JudgedAutomationSummary[]>;
  listRuns(query: DashboardRunsQuery): Promise<DashboardRunsResult>;
  listRunSteps(runId: string): Promise<readonly DashboardRunStep[]>;
}

export interface CreateDashboardDataProviderOptions {
  readonly dashboardStore?: DashboardStore;
  readonly heartbeatTtlMs?: number;
  readonly platform: PlatformServices;
  readonly workerRegistry: Pick<WorkerRegistry, "list">;
  readonly queueName?: string;
  readonly valkeyUrl?: string;
}

export function createDashboardDataProvider(
  options: CreateDashboardDataProviderOptions,
): DashboardDataProvider {
  const dashboardStore = options.dashboardStore ?? createDashboardStore();
  const ownStore = options.dashboardStore === undefined;
  const queue = new Queue(options.queueName ?? DEFAULT_QUEUE_NAME, {
    connection: createBullMqConnection(options.valkeyUrl ?? DEFAULT_VALKEY_URL),
  });
  const heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  // The readme, flow, source and step counts read only the deployments of an automation whose
  // route already checked read access.
  const deployed = (automationSlug: string, environment: string) =>
    dashboardStore.getAutomationDetail(automationSlug, environment, { all: true });
  const deploymentOf = (detail: DashboardAutomationDetail, deploymentId: string | undefined) =>
    deploymentId === undefined
      ? detail.activeDeployment
      : detail.deploymentHistory.find((entry) => entry.deploymentId === deploymentId);
  const liveSchedulerEnvironments = async (): Promise<ReadonlySet<string>> => {
    const observedAt = new Date();
    const schedulers = await dashboardStore.listServiceHeartbeats(null, "scheduler");
    return new Set(
      schedulers
        .filter((heartbeat) => isAlive(heartbeat, observedAt, heartbeatTtlMs))
        .map((heartbeat) => heartbeat.environment),
    );
  };
  const readinessContext = async (environment: string): Promise<ReadinessContext> => {
    const [workers, grants, schedulerEnvironments] = await Promise.all([
      listRegisteredReadinessWorkers(options.workerRegistry, environment),
      options.platform.listAutomationTimeoutGrants(environment),
      liveSchedulerEnvironments(),
    ]);
    return {
      environment,
      grants: new Map(grants.map((grant) => [grant.automationId, grant.maxTimeoutMs])),
      schedulerEnvironments,
      workers,
    };
  };

  return {
    async close() {
      await queue.close();
      if (ownStore) {
        await dashboardStore.close();
      }
    },

    async getAutomationSource(automationSlug, environment, deploymentId) {
      const detail = await deployed(automationSlug, environment);
      if (detail === null) return null;
      const deployment = deploymentOf(detail, deploymentId);
      return deployment === undefined
        ? null
        : await readAutomationSource(automationSlug, deployment);
    },

    async getStepReach(automationSlug, environment) {
      const detail = await deployed(automationSlug, environment);
      if (detail === null) return null;
      return await dashboardStore.countStepReach(automationSlug, environment, STEP_REACH_RUNS);
    },

    async getAutomationDetail(automationSlug, environment, scope) {
      const detail = await dashboardStore.getAutomationDetail(automationSlug, environment, scope);
      if (detail === null) {
        return null;
      }

      return withDetailReadiness(detail, await readinessContext(detail.environment));
    },

    async getAutomationReadme(automationSlug, environment) {
      const detail = await deployed(automationSlug, environment);
      if (detail === null) {
        return null;
      }

      try {
        const storage = createArtifactStorageForReference(detail.activeDeployment);
        const readmeFile = await storage.readTextFile(detail.activeDeployment, "README.md");

        return {
          automationSlug,
          available: readmeFile !== null,
          content: readmeFile?.content ?? null,
          environment: detail.environment,
          error: null,
          filePath: readmeFile?.filePath ?? null,
        } satisfies DashboardAutomationReadme;
      } catch (error) {
        return {
          automationSlug,
          available: false,
          content: null,
          environment: detail.environment,
          error: error instanceof Error ? error.message : String(error),
          filePath: null,
        } satisfies DashboardAutomationReadme;
      }
    },

    async getMermaidDiagram(automationSlug, environment, deploymentId) {
      const detail = await deployed(automationSlug, environment);
      if (detail === null) return null;
      const deployment = deploymentOf(detail, deploymentId);
      if (deployment === undefined) return null;

      try {
        const storage = createArtifactStorageForReference(deployment);
        const mermaidFile = await storage.readTextFile(deployment, "flow.mermaid");

        return {
          automationSlug,
          available: mermaidFile !== null,
          content: mermaidFile?.content ?? null,
          environment: detail.environment,
          error: null,
          filePath: mermaidFile?.filePath ?? null,
        } satisfies DashboardMermaidDiagram;
      } catch (error) {
        return {
          automationSlug,
          available: false,
          content: null,
          environment: detail.environment,
          error: error instanceof Error ? error.message : String(error),
          filePath: null,
        } satisfies DashboardMermaidDiagram;
      }
    },

    async getOperationsSummary(environment) {
      const workers = await reachingWorkers(options.workerRegistry, environment);
      const base = await buildOperabilitySummary({
        dashboardStore,
        environment,
        heartbeatTtlMs,
        profiles: workers.flatMap((worker) => worker.profiles),
        queue,
        queueName: options.queueName ?? DEFAULT_QUEUE_NAME,
        valkeyUrl: options.valkeyUrl ?? DEFAULT_VALKEY_URL,
      });
      const [deliveries, latestMaintenanceRun, recentSamples] = await Promise.all([
        options.platform.listNotificationDeliveries({
          environment: base.environment,
          limit: 20,
        }),
        options.platform.getLatestMaintenanceRun(base.environment),
        options.platform.listQueueMetricSamples(base.environment, 24),
      ]);

      const { maintenanceState, stateReasons } = computeOperationsStateReasons({
        deliveries,
        latestMaintenanceRun,
        observedAt: base.observedAt,
        queueCounts: base.queue.counts,
        services: base.services.instances,
      });

      return {
        ...base,
        onlineWorkers: workers.filter((worker) => worker.state === "online").length,
        maintenance: {
          latestRun: latestMaintenanceRun,
          staleAfterMs: DEFAULT_MAINTENANCE_STALE_MS,
          state: maintenanceState,
        },
        notifications: {
          deliveries,
          failed: deliveries.filter(
            (delivery: PlatformNotificationDeliveryRecord) => delivery.status === "failed",
          ).length,
          sent: deliveries.filter(
            (delivery: PlatformNotificationDeliveryRecord) => delivery.status === "sent",
          ).length,
          skipped: deliveries.filter(
            (delivery: PlatformNotificationDeliveryRecord) => delivery.status === "skipped",
          ).length,
        },
        queue: {
          ...base.queue,
          recentSamples: recentSamples.slice().reverse(),
        },
        state: stateReasons.length > 0 ? "degraded" : "healthy",
        stateReasons,
      } satisfies DashboardOperationsSummary;
    },

    async getOverview(environment, scope, viewer) {
      const observedAt = new Date();
      const schedulerEnvironments = await liveSchedulerEnvironments();
      const workers = await reachingWorkers(options.workerRegistry, environment);
      const dayAgo = new Date(observedAt.getTime() - DAY_MS);
      const [
        last24h,
        automations,
        waitingApprovals,
        queueCounts,
        maintenance,
        deliveries,
        recentChanges,
        queued,
      ] = await Promise.all([
        dashboardStore.countRunsSince(environment, dayAgo, scope),
        dashboardStore.listAutomationSummaries(environment, scope),
        // Only approvals the viewer might decide, before the limit cuts the list.
        dashboardStore.listRuns({
          approvalOnly: true,
          assignedTo: viewer.subjects,
          environment,
          limit: 200,
          scope,
        }),
        // Valkey can be down while Postgres answers; the Overview then still lists what it knows.
        readQueueViews({
          profiles: workers.flatMap((worker) => worker.profiles),
          queue,
          queueName: options.queueName ?? DEFAULT_QUEUE_NAME,
          valkeyUrl: options.valkeyUrl ?? DEFAULT_VALKEY_URL,
        })
          .then(sumQueueCounts)
          .catch(() => null),
        options.platform.getLatestMaintenanceRun(environment),
        options.platform.listNotificationDeliveries({
          createdSince: dayAgo.toISOString(),
          environment,
          limit: 200,
          status: "failed",
        }),
        dashboardStore.listDeploymentChanges(
          environment,
          new Date(observedAt.getTime() - 7 * DAY_MS),
          10,
          scope,
        ),
        dashboardStore.listQueuedRuns(environment, scope),
      ]);
      // Every item an automation raises asks for a change to it, which only an editor can make.
      const editable = (
        await Promise.all(
          automations.map(async (automation) =>
            (await viewer.mayEdit(automation)) ? [automation] : [],
          ),
        )
      ).flat();
      const decidable = await Promise.all(
        waitingApprovals.runs.map(async (run) =>
          run.approval !== null && (await viewer.mayDecide(run, run.approval))
            ? [{ approval: run.approval, run }]
            : [],
        ),
      );
      const approvals = decidable.flat().map(({ approval, run }) => ({
        automation: {
          automationName: run.automationName,
          automationSlug: run.automationSlug,
        },
        ...approval,
        runId: run.runId,
        waitingSince: run.startedAt ?? run.queuedAt,
        waitUntil: run.wait?.reason === "approval" ? run.wait.until : null,
      }));

      return {
        environment,
        last24h,
        needsYou: buildAttention({
          approvals,
          automations: editable,
          deliveries,
          environment,
          schedulerEnvironments,
          latestMaintenanceRun: maintenance,
          observedAt,
          queueCounts,
          queued: queued.map((target) => ({
            ...target,
            placement: explainPlacement(
              { ...target, deadline: new Date(target.deadline) },
              workers,
            ),
          })),
          workers,
        }).filter((item) => viewer.operatesInstance || !INSTANCE_ATTENTION.has(item.kind)),
        complete: viewer.operatesInstance && editable.length === automations.length,
        recentChanges,
      } satisfies DashboardOverview;
    },

    async getOperabilitySummary(environment) {
      return await buildOperabilitySummary({
        dashboardStore,
        environment,
        heartbeatTtlMs,
        profiles: (await reachingWorkers(options.workerRegistry, environment)).flatMap(
          (worker) => worker.profiles,
        ),
        queue,
        queueName: options.queueName ?? DEFAULT_QUEUE_NAME,
        valkeyUrl: options.valkeyUrl ?? DEFAULT_VALKEY_URL,
      });
    },

    async listAutomations(environment, scope) {
      const [automations, context] = await Promise.all([
        dashboardStore.listAutomationSummaries(environment, scope),
        readinessContext(environment),
      ]);
      return automations.map((automation) => withReadiness(automation, context));
    },

    async listRuns(query) {
      return await dashboardStore.listRuns(query);
    },

    async listRunSteps(runId) {
      return await dashboardStore.listRunSteps(runId);
    },
  };
}

/** Reads a deployment's entrypoint; a file that cannot be read becomes `error`, never a throw. */
async function readAutomationSource(
  automationSlug: string,
  deployment: DashboardDeploymentSummary,
): Promise<DashboardAutomationSource> {
  const language = stepSourceLanguage(deployment.runtimeSnapshot.language);
  const base = {
    automationSlug,
    deploymentId: deployment.deploymentId,
    entrypoint: deployment.entrypoint,
    language,
  };
  try {
    const storage = createArtifactStorageForReference(deployment);
    const file = await storage.readTextFile(deployment, deployment.entrypoint);
    if (file === null) {
      return { ...base, content: null, error: "The entrypoint is missing.", steps: [] };
    }
    return {
      ...base,
      content: file.content,
      error: null,
      steps: deployment.buildSnapshot.stepSites,
    };
  } catch (error) {
    return {
      ...base,
      content: null,
      error: error instanceof Error ? error.message : String(error),
      steps: [],
    };
  }
}

/** What readiness judges an automation against: the live workers and scheduler, and timeout grants. */
interface ReadinessContext {
  readonly environment: string;
  /** Each automation's timeout grant in ms, by automation id. */
  readonly grants: ReadonlyMap<string, number>;
  /** The environments a live scheduler serves. */
  readonly schedulerEnvironments: ReadonlySet<string>;
  readonly workers: readonly RegisteredReadinessWorker[];
}

/** Whether a service's last heartbeat is recent enough that it still runs. */
function isAlive(
  heartbeat: { readonly observedAt: string },
  now: Date,
  heartbeatTtlMs: number,
): boolean {
  return now.getTime() - Date.parse(heartbeat.observedAt) <= heartbeatTtlMs;
}

function runtimeReadiness(
  automation: DashboardAutomationSummary,
  deployment: DashboardDeploymentSummary,
  context: ReadinessContext,
): RuntimeReadinessReport {
  return evaluateAutomationReadiness(
    { config: { runtime: deployment.runtimeSnapshot }, directory: deployment.sourceDirectory },
    context.workers.filter((worker) => servesProject(worker, automation.projectId)),
    {
      grantMaxTimeoutMs: context.grants.get(automation.automationId) ?? null,
    },
  );
}

/**
 * The automation with its active deployment's readiness: the persisted runtime snapshot judged
 * against the live workers and its timeout grant, and its secrets and connections as they stand.
 */
export function withReadiness(
  automation: DashboardAutomationSummary,
  context: ReadinessContext,
): JudgedAutomationSummary {
  const readiness = addCredentialIssues(
    runtimeReadiness(automation, automation.activeDeployment, context),
    {
      connections: automation.requiredConnections,
      environment: context.environment,
      secrets: automation.requiredSecrets,
    },
  );
  return {
    ...automation,
    activeDeployment: { ...automation.activeDeployment, readiness },
    trigger: judgeTrigger(automation.trigger, context.schedulerEnvironments),
  };
}

function judgeTrigger(
  trigger: DashboardAutomationSummary["trigger"],
  schedulerEnvironments: ReadonlySet<string>,
): JudgedTriggerSummary | null {
  if (trigger === null) return null;
  const { nextRunAt, triggerType, ...summary } = trigger;
  if (triggerType !== "cron") return { ...summary, triggerType };
  let nextRun: CronNextRun;
  if (!schedulerEnvironments.has(trigger.environment)) {
    nextRun = { kind: "unserved", environment: trigger.environment };
  } else if (nextRunAt === null) {
    nextRun = null;
  } else {
    nextRun = { kind: "at", at: nextRunAt };
  }
  return {
    ...summary,
    triggerType,
    nextRun,
  };
}

function withDetailReadiness(
  automation: DashboardAutomationDetail,
  context: ReadinessContext,
): JudgedAutomationDetail {
  return {
    ...automation,
    ...withReadiness(automation, context),
    // Secrets and connections belong to the active deployment, so earlier ones show the runtime.
    deploymentHistory: automation.deploymentHistory.map((deployment) => ({
      ...deployment,
      readiness: runtimeReadiness(automation, deployment, context),
    })),
  };
}

async function buildOperabilitySummary(input: {
  readonly dashboardStore: DashboardStore;
  readonly environment: string;
  readonly heartbeatTtlMs: number;
  /** The groups of the workers that reach the environment, whose queues the summary counts. */
  readonly profiles: readonly string[];
  readonly queue: Queue;
  readonly queueName: string;
  readonly valkeyUrl: string;
}): Promise<DashboardOperabilitySummary> {
  const { environment } = input;
  // Only instance owners and admins read operability, so it counts every project.
  const scope = { all: true } as const;
  const [automations, recentRuns, heartbeats] = await Promise.all([
    input.dashboardStore.listAutomationSummaries(environment, scope),
    input.dashboardStore.listRuns({ environment, limit: 200, scope }),
    input.dashboardStore.listServiceHeartbeats(environment),
  ]);

  const observedAt = new Date().toISOString();
  const triggerStatusCounts: DashboardOperabilitySummary["triggerStatusCounts"] = {
    active: 0,
    invalid: 0,
    missing: 0,
    paused: 0,
  };
  const runStatusCounts: DashboardOperabilitySummary["runStatusCounts"] = {
    "dead-lettered": 0,
    failed: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    waiting: 0,
  };

  for (const automation of automations) {
    if (automation.trigger === null) {
      triggerStatusCounts.missing += 1;
      continue;
    }

    triggerStatusCounts[automation.trigger.status] += 1;
  }

  for (const run of recentRuns.runs) {
    runStatusCounts[run.status] += 1;
  }

  const heartbeatViews = heartbeats.map((heartbeat) => ({
    ...heartbeat,
    state: isAlive(heartbeat, new Date(observedAt), input.heartbeatTtlMs) ? "alive" : "stale",
  })) satisfies readonly DashboardServiceHeartbeatView[];
  const services = Array.from(new Set(heartbeatViews.map((heartbeat) => heartbeat.service))).sort();
  const queueViews = await readQueueViews({
    profiles: input.profiles,
    queue: input.queue,
    queueName: input.queueName,
    valkeyUrl: input.valkeyUrl,
  });
  const aggregatedQueueCounts = sumQueueCounts(queueViews);

  return {
    automationCount: automations.length,
    environment,
    observedAt,
    queue: {
      counts: aggregatedQueueCounts,
      name: input.queueName,
      queues: queueViews,
    },
    runStatusCounts,
    services: {
      heartbeatTtlMs: input.heartbeatTtlMs,
      instances: heartbeatViews,
      summary: services.map((service) => {
        const serviceHeartbeats = heartbeatViews.filter(
          (heartbeat) => heartbeat.service === service,
        );
        return {
          alive: serviceHeartbeats.filter((heartbeat) => heartbeat.state === "alive").length,
          service,
          stale: serviceHeartbeats.filter((heartbeat) => heartbeat.state === "stale").length,
          total: serviceHeartbeats.length,
        };
      }),
    },
    triggerStatusCounts,
  } satisfies DashboardOperabilitySummary;
}

/** The unrevoked workers whose grants reach an environment. */
async function reachingWorkers(
  registry: Pick<WorkerRegistry, "list">,
  environment: string,
): Promise<readonly WorkerStatus[]> {
  return (await registry.list()).filter(
    (worker) =>
      worker.state !== "revoked" && workerReachesEnvironment(worker.environments, environment),
  );
}

/** Counts of every queue a worker group names, plus the default queue. */
async function readQueueViews(input: {
  readonly profiles: readonly string[];
  readonly queue: Queue;
  readonly queueName: string;
  readonly valkeyUrl: string;
}): Promise<
  readonly { readonly counts: DashboardQueueSummary["counts"]; readonly name: string }[]
> {
  const queueNames = Array.from(
    new Set([...input.profiles.map(createQueueNameForProfile), input.queueName]),
  );
  return await Promise.all(
    queueNames.map(async (queueName) => {
      if (queueName === input.queueName) {
        return { counts: await readQueueCounts(input.queue), name: queueName };
      }

      const queue = new Queue(queueName, {
        connection: createBullMqConnection(input.valkeyUrl),
      });
      try {
        return { counts: await readQueueCounts(queue), name: queueName };
      } finally {
        await queue.close();
      }
    }),
  );
}

function sumQueueCounts(
  views: readonly { readonly counts: DashboardQueueSummary["counts"] }[],
): DashboardQueueSummary["counts"] {
  return views.reduce(
    (totals, view) => ({
      active: totals.active + view.counts.active,
      completed: totals.completed + view.counts.completed,
      delayed: totals.delayed + view.counts.delayed,
      failed: totals.failed + view.counts.failed,
      waiting: totals.waiting + view.counts.waiting,
    }),
    { active: 0, completed: 0, delayed: 0, failed: 0, waiting: 0 },
  );
}

type OperationsMaintenanceState = "healthy" | "degraded" | "missing";

export interface ComputeOperationsStateReasonsInput {
  readonly deliveries: readonly PlatformNotificationDeliveryRecord[];
  readonly latestMaintenanceRun: PlatformMaintenanceRunRecord | null;
  readonly observedAt: string;
  readonly queueCounts: DashboardQueueSummary["counts"];
  readonly services: readonly DashboardServiceHeartbeatView[];
  readonly staleAlertWindowMs?: number;
  readonly maintenanceStaleAfterMs?: number;
}

export interface ComputeOperationsStateReasonsResult {
  readonly maintenanceState: OperationsMaintenanceState;
  readonly stateReasons: readonly string[];
}

/**
 * Pure reducer that turns observed platform signals into the list of
 * `stateReasons` surfaced on the dashboard. Extracted so the alerting rules can
 * be tested in isolation — `getOperationsSummary` otherwise depends on a live
 * queue + control-plane store.
 *
 * Rules:
 *   - `stale-service-heartbeats` fires only when a service went silent within
 *     the alert window. Long-decommissioned rows are ignored until the
 *     maintenance retention job deletes them.
 *   - `queue-pressure` fires on any failed job or sustained backlog.
 *   - `notification-delivery-failed` fires if any recent delivery is marked
 *     failed.
 *   - `maintenance-never-ran` / `maintenance-stale-or-failed` reflect the
 *     latest maintenance run.
 */
export function computeOperationsStateReasons(
  input: ComputeOperationsStateReasonsInput,
): ComputeOperationsStateReasonsResult {
  const staleAlertWindowMs = input.staleAlertWindowMs ?? DEFAULT_STALE_ALERT_WINDOW_MS;
  const maintenanceStaleAfterMs = input.maintenanceStaleAfterMs ?? DEFAULT_MAINTENANCE_STALE_MS;
  const observedAtMs = Date.parse(input.observedAt);
  const stateReasons: string[] = [];

  if (
    input.services.some(
      (service) =>
        service.state === "stale" &&
        observedAtMs - Date.parse(service.observedAt) <= staleAlertWindowMs,
    )
  ) {
    stateReasons.push("stale-service-heartbeats");
  }

  if (input.queueCounts.waiting >= 10 || input.queueCounts.failed > 0) {
    stateReasons.push("queue-pressure");
  }

  if (input.deliveries.some((delivery) => delivery.status === "failed")) {
    stateReasons.push("notification-delivery-failed");
  }

  const maintenanceState: OperationsMaintenanceState =
    input.latestMaintenanceRun === null
      ? "missing"
      : input.latestMaintenanceRun.status === "failed" ||
          observedAtMs - Date.parse(input.latestMaintenanceRun.startedAt) > maintenanceStaleAfterMs
        ? "degraded"
        : "healthy";

  if (maintenanceState !== "healthy") {
    stateReasons.push(
      maintenanceState === "missing" ? "maintenance-never-ran" : "maintenance-stale-or-failed",
    );
  }

  return { maintenanceState, stateReasons };
}

async function readQueueCounts(queue: Queue): Promise<DashboardQueueSummary["counts"]> {
  const counts = await queue.getJobCounts("active", "completed", "delayed", "failed", "waiting");
  return {
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    waiting: counts.waiting ?? 0,
  };
}

function createBullMqConnection(valkeyUrl: string) {
  const url = new URL(valkeyUrl);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;

  return {
    ...(database === undefined || Number.isNaN(database) ? {} : { db: database }),
    host: url.hostname,
    ...(url.password ? { password: url.password } : {}),
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: url.username } : {}),
  };
}
