import type { AutomationConfig } from "@swizzle/config";
import { asc, eq, inArray } from "drizzle-orm";

import type { DatabaseClient } from "./client.js";
import type {
  ConnectionStatus,
  ErrorClassification,
  MaintenanceRunStatus,
  NotificationChannel,
  NotificationDeliveryEventType,
  NotificationDeliveryStatus,
  NotificationEventType,
  PlatformRunExecutionStatus,
  PlatformTriggerStatus,
  PlatformTriggerType,
  RunTriggerType,
  StoredArtifactStorageBackend,
  StoredBuildSnapshot,
  StoredConnection,
  StoredDeployment,
  StoredMaintenanceRun,
  StoredNotificationDelivery,
  StoredNotificationRule,
  StoredQueueMetricSample,
  StoredRun,
  StoredRunExecution,
  StoredRunExecutionConnectionUsage,
  StoredRunExecutionSecretUsage,
  StoredRuntimeSnapshot,
  StoredSecret,
  StoredTrigger,
  StoredWebhookRunContext,
} from "./control-plane-types.js";
import { normalizeStoredArtifactLocator } from "./dashboard-shared.js";
import type { ExecutionWait } from "./run-approval.js";
import {
  automations,
  automationTriggerChainSources,
  automationTriggers,
  automationVersions,
  deployments,
  notificationDeliveries,
  notificationRules,
  runExecutionConnectionUsages,
  runExecutionSecretUsages,
  runExecutions,
  runs,
} from "./schema.js";

type ControlPlaneTransaction = Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0];
type ChainSourceLookupClient = DatabaseClient["db"] | ControlPlaneTransaction;

export const triggerProjection = {
  automationId: automations.id,
  automationName: automations.name,
  automationSlug: automations.slug,
  chainOnStatus: automationTriggers.chainOnStatus,
  chainPayloadMode: automationTriggers.chainPayloadMode,
  chainSourceAutomationId: automationTriggers.chainSourceAutomationId,
  config: automationVersions.config,
  cronIntervalMs: automationTriggers.cronIntervalMs,
  cronSchedule: automationTriggers.cronSchedule,
  deploymentId: automationTriggers.deploymentId,
  environment: automationTriggers.environment,
  errorCode: automationTriggers.errorCode,
  errorMessage: automationTriggers.errorMessage,
  nextRunAt: automationTriggers.nextRunAt,
  pausedAt: automationTriggers.pausedAt,
  projectId: automations.projectId,
  status: automationTriggers.status,
  triggerId: automationTriggers.id,
  triggerType: automationTriggers.triggerType,
  updatedAt: automationTriggers.updatedAt,
  versionId: automationTriggers.versionId,
  webhookPath: automationTriggers.webhookPath,
} as const;

export async function getChainSourceAutomationIds(
  db: ChainSourceLookupClient,
  triggerId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ sourceAutomationId: automationTriggerChainSources.sourceAutomationId })
    .from(automationTriggerChainSources)
    .where(eq(automationTriggerChainSources.triggerId, triggerId))
    .orderBy(
      asc(automationTriggerChainSources.createdAt),
      asc(automationTriggerChainSources.sourceAutomationId),
    );

  return rows.map((row) => row.sourceAutomationId);
}

export async function getChainSourceAutomationIdsByTriggerId(
  db: ChainSourceLookupClient,
  triggerIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (triggerIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      sourceAutomationId: automationTriggerChainSources.sourceAutomationId,
      triggerId: automationTriggerChainSources.triggerId,
    })
    .from(automationTriggerChainSources)
    .where(inArray(automationTriggerChainSources.triggerId, [...triggerIds]))
    .orderBy(
      asc(automationTriggerChainSources.triggerId),
      asc(automationTriggerChainSources.createdAt),
      asc(automationTriggerChainSources.sourceAutomationId),
    );

  const byTriggerId = new Map<string, string[]>();
  for (const row of rows) {
    const sources = byTriggerId.get(row.triggerId);
    if (sources) {
      sources.push(row.sourceAutomationId);
    } else {
      byTriggerId.set(row.triggerId, [row.sourceAutomationId]);
    }
  }

  return byTriggerId;
}

export async function getDeploymentById(
  client: DatabaseClient,
  deploymentId: string,
): Promise<StoredDeployment | null> {
  const [row] = await client.db
    .select({
      artifactBackend: deployments.artifactBackend,
      artifactLocator: deployments.artifactLocator,
      artifactRootPath: deployments.artifactRootPath,
      automationId: automations.id,
      automationName: automations.name,
      automationSlug: automations.slug,
      buildSnapshot: deployments.buildSnapshot,
      config: automationVersions.config,
      deployedAt: deployments.deployedAt,
      deploymentId: deployments.id,
      entrypoint: automationVersions.entrypoint,
      environment: deployments.environment,
      manifestPath: deployments.manifestPath,
      projectId: automations.projectId,
      runtimeSnapshot: deployments.runtimeSnapshot,
      seq: deployments.seq,
      sourceDirectory: deployments.sourceDirectory,
      sourceHash: automationVersions.sourceHash,
      status: deployments.status,
      version: automationVersions.version,
      versionId: automationVersions.id,
    })
    .from(deployments)
    .innerJoin(automations, eq(deployments.automationId, automations.id))
    .innerJoin(automationVersions, eq(deployments.versionId, automationVersions.id))
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  return row ? mapDeploymentRow(row) : null;
}

export async function getTriggerById(
  client: DatabaseClient,
  triggerId: string,
): Promise<StoredTrigger | null> {
  const [row] = await client.db
    .select(triggerProjection)
    .from(automationTriggers)
    .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
    .innerJoin(automationVersions, eq(automationTriggers.versionId, automationVersions.id))
    .where(eq(automationTriggers.id, triggerId))
    .limit(1);

  return row
    ? mapTriggerRow({
        ...row,
        chainSourceAutomationIds: await getChainSourceAutomationIds(client.db, row.triggerId),
      })
    : null;
}

export async function getRunById(client: DatabaseClient, runId: string): Promise<StoredRun | null> {
  const [runRow] = await client.db
    .select({
      artifactBackend: deployments.artifactBackend,
      artifactLocator: deployments.artifactLocator,
      artifactRootPath: deployments.artifactRootPath,
      attemptsMade: runs.attemptsMade,
      attemptsMax: runs.attemptsMax,
      automationId: automations.id,
      automationName: automations.name,
      automationSlug: automations.slug,
      chainOriginRunId: runs.chainOriginRunId,
      chainSourceRunIds: runs.chainSourceRunIds,
      config: automationVersions.config,
      correlationId: runs.correlationId,
      deadLetterReason: runs.deadLetterReason,
      deploymentId: deployments.id,
      environment: deployments.environment,
      errorCause: runs.errorCause,
      errorClassification: runs.errorClassification,
      errorCode: runs.errorCode,
      errorMessage: runs.errorMessage,
      errorStack: runs.errorStack,
      finishedAt: runs.finishedAt,
      invokeDepth: runs.invokeDepth,
      manifestPath: deployments.manifestPath,
      payload: runs.payload,
      parentRunId: runs.parentRunId,
      parentStepKey: runs.parentStepKey,
      projectId: runs.projectId,
      queueJobId: runs.queueJobId,
      queueName: runs.queueName,
      queuedAt: runs.queuedAt,
      result: runs.result,
      resumeCount: runs.resumeCount,
      runId: runs.id,
      sourceDirectory: deployments.sourceDirectory,
      startedAt: runs.startedAt,
      status: runs.status,
      stderr: runs.stderr,
      stdout: runs.stdout,
      triggerType: runs.triggerType,
      version: automationVersions.version,
      versionId: automationVersions.id,
      wait: runs.wait,
      webhookContext: runs.webhookContext,
    })
    .from(runs)
    .innerJoin(automations, eq(runs.automationId, automations.id))
    .innerJoin(automationVersions, eq(runs.versionId, automationVersions.id))
    .innerJoin(deployments, eq(runs.deploymentId, deployments.id))
    .where(eq(runs.id, runId))
    .limit(1);

  if (!runRow) {
    return null;
  }

  const executionRows = await client.db
    .select({
      executionId: runExecutions.id,
      executionNumber: runExecutions.executionNumber,
      durationMs: runExecutions.durationMs,
      errorCause: runExecutions.errorCause,
      errorClassification: runExecutions.errorClassification,
      errorCode: runExecutions.errorCode,
      errorMessage: runExecutions.errorMessage,
      errorStack: runExecutions.errorStack,
      finishedAt: runExecutions.finishedAt,
      lastHeartbeatAt: runExecutions.lastHeartbeatAt,
      metadata: runExecutions.metadata,
      phase: runExecutions.phase,
      queueJobId: runExecutions.queueJobId,
      runId: runExecutions.runId,
      attempt: runExecutions.attempt,
      startedAt: runExecutions.startedAt,
      status: runExecutions.status,
      stderr: runExecutions.stderr,
      wait: runExecutions.wait,
      workerName: runExecutions.workerName,
      stdout: runExecutions.stdout,
    })
    .from(runExecutions)
    .where(eq(runExecutions.runId, runId))
    .orderBy(asc(runExecutions.executionNumber));

  const secretUsageRows = await client.db
    .select({
      algorithm: runExecutionSecretUsages.algorithm,
      executionNumber: runExecutionSecretUsages.executionNumber,
      environment: runExecutionSecretUsages.environment,
      injectedAt: runExecutionSecretUsages.injectedAt,
      keyVersion: runExecutionSecretUsages.keyVersion,
      runId: runExecutionSecretUsages.runId,
      secretName: runExecutionSecretUsages.secretName,
      secretVersion: runExecutionSecretUsages.secretVersion,
    })
    .from(runExecutionSecretUsages)
    .where(eq(runExecutionSecretUsages.runId, runId))
    .orderBy(
      asc(runExecutionSecretUsages.executionNumber),
      asc(runExecutionSecretUsages.secretName),
    );

  const secretUsagesByExecution = new Map<number, StoredRunExecutionSecretUsage[]>();
  for (const row of secretUsageRows) {
    const executionUsages = secretUsagesByExecution.get(row.executionNumber) ?? [];
    executionUsages.push(mapRunExecutionSecretUsageRow(row));
    secretUsagesByExecution.set(row.executionNumber, executionUsages);
  }

  const connectionUsageRows = await client.db
    .select({
      executionNumber: runExecutionConnectionUsages.executionNumber,
      connectionName: runExecutionConnectionUsages.connectionName,
      environment: runExecutionConnectionUsages.environment,
      injectedAt: runExecutionConnectionUsages.injectedAt,
      provider: runExecutionConnectionUsages.provider,
      runId: runExecutionConnectionUsages.runId,
      tokenVersion: runExecutionConnectionUsages.tokenVersion,
    })
    .from(runExecutionConnectionUsages)
    .where(eq(runExecutionConnectionUsages.runId, runId))
    .orderBy(
      asc(runExecutionConnectionUsages.executionNumber),
      asc(runExecutionConnectionUsages.connectionName),
    );

  const connectionUsagesByExecution = new Map<number, StoredRunExecutionConnectionUsage[]>();
  for (const row of connectionUsageRows) {
    const executionUsages = connectionUsagesByExecution.get(row.executionNumber) ?? [];
    executionUsages.push({
      executionNumber: row.executionNumber,
      connectionName: row.connectionName,
      environment: row.environment,
      injectedAt: row.injectedAt.toISOString(),
      provider: row.provider,
      runId: row.runId,
      tokenVersion: row.tokenVersion,
    });
    connectionUsagesByExecution.set(row.executionNumber, executionUsages);
  }

  return {
    artifactBackend: runRow.artifactBackend as StoredArtifactStorageBackend,
    artifactLocator: normalizeStoredArtifactLocator(
      runRow.artifactBackend,
      runRow.artifactLocator,
      runRow.artifactRootPath,
    ),
    artifactRootPath: runRow.artifactRootPath,
    executions: executionRows.map((row, index) =>
      mapExecutionRow(
        row,
        // Only a suspended execution has a wait, and the next one resumed after it.
        executionRows[index - 1]?.wait ?? null,
        secretUsagesByExecution.get(row.executionNumber) ?? [],
        connectionUsagesByExecution.get(row.executionNumber) ?? [],
      ),
    ),
    attemptsMade: runRow.attemptsMade,
    attemptsMax: runRow.attemptsMax,
    automationId: runRow.automationId,
    automationName: runRow.automationName,
    automationSlug: runRow.automationSlug,
    chainOriginRunId: runRow.chainOriginRunId,
    chainSourceRunIds: runRow.chainSourceRunIds,
    config: runRow.config as AutomationConfig,
    correlationId: runRow.correlationId,
    deadLetterReason: runRow.deadLetterReason,
    deploymentId: runRow.deploymentId,
    environment: runRow.environment,
    errorCause: runRow.errorCause,
    errorClassification: (runRow.errorClassification as ErrorClassification | null) ?? null,
    errorCode: runRow.errorCode,
    errorMessage: runRow.errorMessage,
    errorStack: runRow.errorStack,
    finishedAt: toIsoString(runRow.finishedAt),
    invokeDepth: runRow.invokeDepth,
    manifestPath: runRow.manifestPath,
    payload: runRow.payload,
    parentRunId: runRow.parentRunId,
    parentStepKey: runRow.parentStepKey,
    projectId: runRow.projectId,
    queueJobId: runRow.queueJobId,
    queueName: runRow.queueName,
    queuedAt: toRequiredIsoString(runRow.queuedAt),
    result: runRow.result,
    resumeCount: runRow.resumeCount,
    runId: runRow.runId,
    sourceDirectory: runRow.sourceDirectory,
    startedAt: toIsoString(runRow.startedAt),
    status: runRow.status,
    stderr: runRow.stderr,
    stdout: runRow.stdout,
    triggerType: runRow.triggerType as RunTriggerType,
    version: runRow.version,
    versionId: runRow.versionId,
    wait: runRow.wait,
    webhookContext: normalizeStoredWebhookRunContext(runRow.webhookContext),
  };
}

/** A rule's columns, with its automation's name read through a left join on `automations`. */
export const NOTIFICATION_RULE_COLUMNS = {
  automationId: automations.id,
  automationName: automations.name,
  automationSlug: automations.slug,
  channel: notificationRules.channel,
  chatId: notificationRules.chatId,
  cooldownSeconds: notificationRules.cooldownSeconds,
  createdAt: notificationRules.createdAt,
  enabled: notificationRules.enabled,
  environment: notificationRules.environment,
  eventType: notificationRules.eventType,
  projectId: notificationRules.projectId,
  ruleId: notificationRules.id,
  threshold: notificationRules.threshold,
  updatedAt: notificationRules.updatedAt,
  userId: notificationRules.userId,
  windowSeconds: notificationRules.windowSeconds,
};

export async function getNotificationRuleById(
  client: DatabaseClient,
  ruleId: string,
): Promise<StoredNotificationRule | null> {
  const [row] = await client.db
    .select(NOTIFICATION_RULE_COLUMNS)
    .from(notificationRules)
    .leftJoin(automations, eq(notificationRules.automationId, automations.id))
    .where(eq(notificationRules.id, ruleId))
    .limit(1);

  return row ? mapNotificationRuleRow(row) : null;
}

export async function getNotificationDeliveryById(
  client: DatabaseClient,
  deliveryId: string,
): Promise<StoredNotificationDelivery | null> {
  const [row] = await client.db
    .select({
      automationId: automations.id,
      automationName: automations.name,
      automationSlug: automations.slug,
      channel: notificationDeliveries.channel,
      chatId: notificationDeliveries.chatId,
      createdAt: notificationDeliveries.createdAt,
      dedupeKey: notificationDeliveries.dedupeKey,
      deliveredAt: notificationDeliveries.deliveredAt,
      deliveryId: notificationDeliveries.id,
      environment: notificationDeliveries.environment,
      errorMessage: notificationDeliveries.errorMessage,
      eventType: notificationDeliveries.eventType,
      metadata: notificationDeliveries.metadata,
      providerMessageId: notificationDeliveries.providerMessageId,
      ruleId: notificationDeliveries.ruleId,
      runId: notificationDeliveries.runId,
      status: notificationDeliveries.status,
      updatedAt: notificationDeliveries.updatedAt,
    })
    .from(notificationDeliveries)
    .innerJoin(automations, eq(notificationDeliveries.automationId, automations.id))
    .where(eq(notificationDeliveries.id, deliveryId))
    .limit(1);

  return row ? mapNotificationDeliveryRow(row) : null;
}

export async function getNotificationDeliveryByDedupeKey(
  client: DatabaseClient,
  dedupeKey: string,
): Promise<StoredNotificationDelivery | null> {
  const [row] = await client.db
    .select({
      automationId: automations.id,
      automationName: automations.name,
      automationSlug: automations.slug,
      channel: notificationDeliveries.channel,
      chatId: notificationDeliveries.chatId,
      createdAt: notificationDeliveries.createdAt,
      dedupeKey: notificationDeliveries.dedupeKey,
      deliveredAt: notificationDeliveries.deliveredAt,
      deliveryId: notificationDeliveries.id,
      environment: notificationDeliveries.environment,
      errorMessage: notificationDeliveries.errorMessage,
      eventType: notificationDeliveries.eventType,
      metadata: notificationDeliveries.metadata,
      providerMessageId: notificationDeliveries.providerMessageId,
      ruleId: notificationDeliveries.ruleId,
      runId: notificationDeliveries.runId,
      status: notificationDeliveries.status,
      updatedAt: notificationDeliveries.updatedAt,
    })
    .from(notificationDeliveries)
    .innerJoin(automations, eq(notificationDeliveries.automationId, automations.id))
    .where(eq(notificationDeliveries.dedupeKey, dedupeKey))
    .limit(1);

  return row ? mapNotificationDeliveryRow(row) : null;
}

export function mapNotificationRuleRow(row: {
  readonly automationId: string | null;
  readonly automationName: string | null;
  readonly automationSlug: string | null;
  readonly channel: string;
  readonly chatId: string;
  readonly cooldownSeconds: number;
  readonly createdAt: Date;
  readonly enabled: boolean;
  readonly environment: string;
  readonly eventType: string;
  readonly projectId: string;
  readonly ruleId: string;
  readonly threshold: number;
  readonly updatedAt: Date;
  readonly userId: string;
  readonly windowSeconds: number;
}): StoredNotificationRule {
  return {
    userId: row.userId,
    projectId: row.projectId,
    automationId: row.automationId,
    automationName: row.automationName,
    automationSlug: row.automationSlug,
    channel: row.channel as NotificationChannel,
    chatId: row.chatId,
    cooldownSeconds: row.cooldownSeconds,
    createdAt: row.createdAt.toISOString(),
    enabled: row.enabled,
    environment: row.environment,
    eventType: row.eventType as NotificationEventType,
    ruleId: row.ruleId,
    threshold: row.threshold,
    updatedAt: row.updatedAt.toISOString(),
    windowSeconds: row.windowSeconds,
  };
}

export function mapNotificationDeliveryRow(row: {
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly channel: string;
  readonly chatId: string;
  readonly createdAt: Date;
  readonly dedupeKey: string;
  readonly deliveredAt: Date | null;
  readonly deliveryId: string;
  readonly environment: string;
  readonly errorMessage: string | null;
  readonly eventType: string;
  readonly metadata: unknown;
  readonly providerMessageId: string | null;
  readonly ruleId: string | null;
  readonly runId: string | null;
  readonly status: string;
  readonly updatedAt: Date;
}): StoredNotificationDelivery {
  return {
    automationId: row.automationId,
    automationName: row.automationName,
    automationSlug: row.automationSlug,
    channel: row.channel as NotificationChannel,
    chatId: row.chatId,
    createdAt: row.createdAt.toISOString(),
    dedupeKey: row.dedupeKey,
    deliveredAt: toIsoString(row.deliveredAt),
    deliveryId: row.deliveryId,
    environment: row.environment,
    errorMessage: row.errorMessage,
    eventType: row.eventType as NotificationDeliveryEventType,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    providerMessageId: row.providerMessageId,
    ruleId: row.ruleId,
    runId: row.runId,
    status: row.status as NotificationDeliveryStatus,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapQueueMetricSampleRow(row: {
  readonly active: number;
  readonly completed: number;
  readonly delayed: number;
  readonly environment: string;
  readonly failed: number;
  readonly observedAt: Date;
  readonly queueName: string;
  readonly sampleId: string;
  readonly waiting: number;
}): StoredQueueMetricSample {
  return {
    counts: {
      active: row.active,
      completed: row.completed,
      delayed: row.delayed,
      failed: row.failed,
      waiting: row.waiting,
    },
    environment: row.environment,
    observedAt: row.observedAt.toISOString(),
    queueName: row.queueName,
    sampleId: row.sampleId,
  };
}

export function mapMaintenanceRunRow(row: {
  readonly createdAt: Date;
  readonly environment: string;
  readonly errorMessage: string | null;
  readonly finishedAt: Date | null;
  readonly maintenanceRunId: string;
  readonly startedAt: Date;
  readonly status: string;
  readonly summary: unknown;
}): StoredMaintenanceRun {
  return {
    createdAt: row.createdAt.toISOString(),
    environment: row.environment,
    errorMessage: row.errorMessage,
    finishedAt: toIsoString(row.finishedAt),
    maintenanceRunId: row.maintenanceRunId,
    startedAt: row.startedAt.toISOString(),
    status: row.status as MaintenanceRunStatus,
    summary: (row.summary as Record<string, unknown> | null) ?? {},
  };
}

export function mapDeploymentRow(row: {
  readonly artifactBackend: string;
  readonly artifactLocator: unknown;
  readonly artifactRootPath: string;
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly buildSnapshot: unknown;
  readonly config: unknown;
  readonly deployedAt: Date;
  readonly deploymentId: string;
  readonly entrypoint: string;
  readonly environment: string;
  readonly manifestPath: string;
  readonly projectId: string;
  readonly runtimeSnapshot: unknown;
  readonly seq: number;
  readonly sourceDirectory: string;
  readonly sourceHash: string;
  readonly status: string;
  readonly version: string;
  readonly versionId: string;
}): StoredDeployment {
  const config = row.config as AutomationConfig;

  return {
    artifactBackend: row.artifactBackend as StoredArtifactStorageBackend,
    artifactLocator: normalizeStoredArtifactLocator(
      row.artifactBackend,
      row.artifactLocator,
      row.artifactRootPath,
    ),
    artifactRootPath: row.artifactRootPath,
    automationId: row.automationId,
    automationName: row.automationName,
    automationSlug: row.automationSlug,
    buildSnapshot: row.buildSnapshot as StoredBuildSnapshot,
    config,
    deployedAt: row.deployedAt.toISOString(),
    deploymentId: row.deploymentId,
    entrypoint: row.entrypoint,
    environment: row.environment,
    manifestPath: row.manifestPath,
    projectId: row.projectId,
    runtimeSnapshot: row.runtimeSnapshot as StoredRuntimeSnapshot,
    seq: row.seq,
    sourceDirectory: row.sourceDirectory,
    sourceHash: row.sourceHash,
    status: row.status,
    triggerType: config.trigger.type,
    version: row.version,
    versionId: row.versionId,
  };
}

export function mapTriggerRow(row: {
  readonly automationId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly chainOnStatus: string | null;
  readonly chainPayloadMode: string | null;
  readonly chainSourceAutomationId: string | null;
  readonly chainSourceAutomationIds?: readonly string[];
  readonly config: unknown;
  readonly cronIntervalMs: number | null;
  readonly cronSchedule: string | null;
  readonly deploymentId: string;
  readonly environment: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly nextRunAt: Date | null;
  readonly pausedAt: Date | null;
  readonly projectId: string;
  readonly status: string;
  readonly triggerId: string;
  readonly triggerType: string;
  readonly updatedAt: Date;
  readonly versionId: string;
  readonly webhookPath: string | null;
}): StoredTrigger {
  return {
    automationId: row.automationId,
    automationName: row.automationName,
    automationSlug: row.automationSlug,
    chainOnStatus: row.chainOnStatus,
    chainPayloadMode: row.chainPayloadMode,
    chainSourceAutomationId: row.chainSourceAutomationId,
    chainSourceAutomationIds: row.chainSourceAutomationIds ?? [],
    config: row.config as AutomationConfig,
    cronIntervalMs: row.cronIntervalMs,
    cronSchedule: row.cronSchedule,
    deploymentId: row.deploymentId,
    environment: row.environment,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    nextRunAt: toIsoString(row.nextRunAt),
    pausedAt: toIsoString(row.pausedAt),
    projectId: row.projectId,
    status: row.status as PlatformTriggerStatus,
    triggerId: row.triggerId,
    triggerType: row.triggerType as PlatformTriggerType,
    updatedAt: row.updatedAt.toISOString(),
    versionId: row.versionId,
    webhookPath: row.webhookPath,
  };
}

export function mapSecretRow(row: {
  readonly algorithm: string;
  readonly createdAt: Date;
  readonly environment: string;
  readonly id: string;
  readonly keyVersion: string;
  readonly name: string;
  readonly projectId: string;
  readonly secretVersion: number;
  readonly updatedAt: Date;
}): StoredSecret {
  return {
    algorithm: row.algorithm,
    createdAt: row.createdAt.toISOString(),
    environment: row.environment,
    id: row.id,
    keyVersion: row.keyVersion,
    name: row.name,
    projectId: row.projectId,
    secretVersion: row.secretVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapConnectionRow(row: {
  readonly accessTokenExpiresAt: Date | null;
  readonly clientId: string;
  readonly createdAt: Date;
  readonly environment: string;
  readonly id: string;
  readonly lastErrorAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly lastRefreshedAt: Date | null;
  readonly name: string;
  readonly pendingExpiresAt: Date | null;
  readonly projectId: string;
  readonly provider: string;
  readonly providerConfig: unknown;
  readonly scopes: unknown;
  readonly status: string;
  readonly tokenVersion: number;
  readonly updatedAt: Date;
}): StoredConnection {
  return {
    accessTokenExpiresAt: toIsoString(row.accessTokenExpiresAt),
    authorizationPending:
      row.pendingExpiresAt !== null && row.pendingExpiresAt.getTime() > Date.now(),
    clientId: row.clientId,
    createdAt: row.createdAt.toISOString(),
    environment: row.environment,
    id: row.id,
    lastErrorAt: toIsoString(row.lastErrorAt),
    lastErrorCode: row.lastErrorCode,
    lastRefreshedAt: toIsoString(row.lastRefreshedAt),
    name: row.name,
    projectId: row.projectId,
    provider: row.provider,
    providerConfig: isRecord(row.providerConfig) ? row.providerConfig : null,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    status: row.status as ConnectionStatus,
    tokenVersion: row.tokenVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeStoredWebhookRunContext(value: unknown): StoredWebhookRunContext | null {
  if (!isRecord(value)) {
    return null;
  }

  const headers = isRecord(value.headers) ? value.headers : null;
  if (
    headers === null ||
    typeof value.rawBodyBase64 !== "string" ||
    typeof value.rawBodyByteLength !== "number" ||
    typeof value.rawBodySha256 !== "string"
  ) {
    return null;
  }

  return {
    headers: Object.fromEntries(
      Object.entries(headers).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    ),
    rawBodyBase64: value.rawBodyBase64,
    rawBodyByteLength: value.rawBodyByteLength,
    rawBodySha256: value.rawBodySha256,
  };
}

function mapRunExecutionSecretUsageRow(row: {
  readonly algorithm: string;
  readonly executionNumber: number;
  readonly environment: string;
  readonly injectedAt: Date;
  readonly keyVersion: string;
  readonly runId: string;
  readonly secretName: string;
  readonly secretVersion: number;
}): StoredRunExecutionSecretUsage {
  return {
    algorithm: row.algorithm,
    executionNumber: row.executionNumber,
    environment: row.environment,
    injectedAt: row.injectedAt.toISOString(),
    keyVersion: row.keyVersion,
    runId: row.runId,
    secretName: row.secretName,
    secretVersion: row.secretVersion,
  };
}

function mapExecutionRow(
  row: {
    readonly executionId: string;
    readonly executionNumber: number;
    readonly durationMs: number | null;
    readonly errorCause: string | null;
    readonly errorClassification: string | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly errorStack: string | null;
    readonly finishedAt: Date | null;
    readonly lastHeartbeatAt: Date | null;
    readonly metadata: unknown;
    readonly phase: StoredRunExecution["phase"];
    readonly queueJobId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly startedAt: Date;
    readonly status: string;
    readonly stderr: string;
    readonly stdout: string;
    readonly wait: ExecutionWait | null;
    readonly workerName: string;
  },
  resumedAfter: ExecutionWait | null,
  secretUsages: readonly StoredRunExecutionSecretUsage[],
  connectionUsages: readonly StoredRunExecutionConnectionUsage[] = [],
): StoredRunExecution {
  return {
    executionId: row.executionId,
    connectionUsages,
    executionNumber: row.executionNumber,
    durationMs: row.durationMs,
    errorCause: row.errorCause,
    errorClassification: (row.errorClassification as ErrorClassification | null) ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    errorStack: row.errorStack,
    finishedAt: toIsoString(row.finishedAt),
    lastHeartbeatAt: toIsoString(row.lastHeartbeatAt),
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    phase: row.phase,
    queueJobId: row.queueJobId,
    runId: row.runId,
    secretUsages,
    attempt: row.attempt,
    resumedAfter,
    startedAt: row.startedAt.toISOString(),
    status: row.status as PlatformRunExecutionStatus,
    stderr: row.stderr,
    stdout: row.stdout,
    wait: row.wait,
    workerName: row.workerName,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toRequiredIsoString(value: Date): string {
  return value.toISOString();
}
