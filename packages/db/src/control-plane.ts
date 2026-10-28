import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import {
  countProjectContents as countStoredProjectContents,
  deleteAutomation as deleteStoredAutomation,
  deleteProject as deleteStoredProject,
  listAutomationChainDependents as listStoredAutomationChainDependents,
  moveAutomation as moveStoredAutomation,
} from "./control-plane-automations.js";
import {
  completeAutomationCheck as completeStoredAutomationCheck,
  getAutomationCheck as getStoredAutomationCheck,
  listDueAutomationChecks as listStoredDueAutomationChecks,
  recordApiContacts as recordStoredApiContacts,
} from "./control-plane-checks.js";
import {
  beginConnectionAuthorization as beginStoredConnectionAuthorization,
  consumeConnectionAuthorization as consumeStoredConnectionAuthorization,
  deleteConnection as deleteStoredConnection,
  getConnection as getStoredConnection,
  getConnectionCredentials as getStoredConnectionCredentials,
  listConnections as listStoredConnections,
  markConnectionError as markStoredConnectionError,
  recordRunExecutionConnectionUsages as recordStoredRunExecutionConnectionUsages,
  resolveConnectionToken as resolveStoredConnectionToken,
  storeConnectionTokens as storeStoredConnectionTokens,
} from "./control-plane-connections.js";
import {
  acceptCredentialShare as acceptStoredCredentialShare,
  findCredential as findStoredCredential,
  findDeploymentCredentials as findStoredDeploymentCredentials,
  listCredentialShares as listStoredCredentialShares,
  offerCredentialShare as offerStoredCredentialShare,
  removeCredentialGrant as removeStoredCredentialGrant,
  removeCredentialShare as removeStoredCredentialShare,
  setCredentialGrant as setStoredCredentialGrant,
  boundCredentials as storedBoundCredentials,
  credentialAccess as storedCredentialAccess,
} from "./control-plane-credentials.js";
import {
  createDeploymentAuditEvent as createStoredDeploymentAuditEvent,
  findSecretDeclarationCollisions as findStoredSecretDeclarationCollisions,
  getActiveDeploymentBySlug as getStoredActiveDeploymentBySlug,
  listActiveDeployments as listStoredActiveDeployments,
  listDeploymentAuditEventsByAutomationSlug as listStoredDeploymentAuditEventsByAutomationSlug,
  listDeploymentsByAutomationSlug as listStoredDeploymentsByAutomationSlug,
  listDeploymentsForArtifactRetention as listStoredDeploymentsForArtifactRetention,
} from "./control-plane-deployment-records.js";
import {
  commitDeployment as commitStoredDeployment,
  commitRollbackDeployment as commitStoredRollbackDeployment,
} from "./control-plane-deployments.js";
import {
  cleanupMaintenanceData as cleanupStoredMaintenanceData,
  createMaintenanceRun as createStoredMaintenanceRun,
  createQueueMetricSample as createStoredQueueMetricSample,
  expireRuns as expireStoredRuns,
  getLatestMaintenanceRun as getLatestStoredMaintenanceRun,
  listQueueMetricSamples as listStoredQueueMetricSamples,
} from "./control-plane-maintenance.js";
import {
  createNotificationRule as createStoredNotificationRule,
  deleteNotificationRule as deleteStoredNotificationRule,
  getLatestNotificationDeliveryForRule as getLatestStoredNotificationDeliveryForRule,
  getNotificationRule as getStoredNotificationRule,
  listNotificationDeliveries as listStoredNotificationDeliveries,
  listNotificationRules as listStoredNotificationRules,
  recordNotificationDelivery as recordStoredNotificationDelivery,
  updateNotificationDelivery as updateStoredNotificationDelivery,
  updateNotificationRule as updateStoredNotificationRule,
} from "./control-plane-notifications.js";
import { personMayRead, resolveApprovalAssignee } from "./control-plane-people.js";
import { getDeploymentById } from "./control-plane-read-models.js";
import {
  appendRunExecutionOutput as appendStoredRunExecutionOutput,
  cancelRun as cancelStoredRun,
  completeRunExecution as completeStoredRunExecution,
  countActiveRunsForAutomation as countStoredActiveRunsForAutomation,
  countDeadLetteredRunsSince as countStoredDeadLetteredRunsSince,
  createChainJoinRun as createStoredChainJoinRun,
  createRun as createStoredRun,
  createRunExecution as createStoredRunExecution,
  findSucceededChainSourceRuns as findStoredSucceededChainSourceRuns,
  getRun as getStoredRun,
  listChildRuns as listStoredChildRuns,
  listDueSleepingRuns as listStoredDueSleepingRuns,
  listDueWaitingRuns as listStoredDueWaitingRuns,
  listQueuedRuns as listStoredQueuedRuns,
  listWaitingEventRuns as listStoredWaitingEventRuns,
  markRunExecutionReady as markStoredRunExecutionReady,
  reassignApproval as reassignStoredApproval,
  resumeWaitingRun as resumeStoredWaitingRun,
  updateRunExecutionHeartbeat as updateStoredRunExecutionHeartbeat,
  updateRunState as updateStoredRunState,
} from "./control-plane-runs.js";
import {
  deleteSecret as deleteStoredSecret,
  getSecret as getStoredSecret,
  listSecrets as listStoredSecrets,
  recordRunExecutionSecretUsages as recordStoredRunExecutionSecretUsages,
  resolveSecrets as resolveStoredSecrets,
  upsertSecret as upsertStoredSecret,
} from "./control-plane-secrets.js";
import {
  claimAutomationStateKey as claimStoredAutomationStateKey,
  deleteAutomationStateValue as deleteStoredAutomationStateValue,
  getAutomationStateValue as getStoredAutomationStateValue,
  listAutomationState as listStoredAutomationState,
  setAutomationStateValue as setStoredAutomationStateValue,
} from "./control-plane-state.js";
import {
  getRunStepTotals as getStoredRunStepTotals,
  listRunSteps as listStoredRunSteps,
  setRunStepResult as setStoredRunStepResult,
  startRunStep as startStoredRunStep,
} from "./control-plane-steps.js";
import {
  deleteAutomationTimeoutGrant as deleteStoredAutomationTimeoutGrant,
  getAutomationTimeoutGrant as getStoredAutomationTimeoutGrant,
  listAutomationTimeoutGrantAuditEvents as listStoredAutomationTimeoutGrantAuditEvents,
  listAutomationTimeoutGrants as listStoredAutomationTimeoutGrants,
  setAutomationTimeoutGrant as setStoredAutomationTimeoutGrant,
} from "./control-plane-timeout-grants.js";
import {
  advanceCronTriggerCursor as advanceStoredCronTriggerCursor,
  createTriggerAuditEvent as createStoredTriggerAuditEvent,
  getAutomationTriggerBySlug as getStoredAutomationTriggerBySlug,
  getChainTriggersForSource as getStoredChainTriggersForSource,
  getDueCronTriggers as getStoredDueCronTriggers,
  getWebhookTriggerByPath as getStoredWebhookTriggerByPath,
  listTriggerAuditEventsByAutomationSlug as listStoredTriggerAuditEventsByAutomationSlug,
  updateAutomationTriggerStatus as updateStoredAutomationTriggerStatus,
} from "./control-plane-triggers.js";
import { automationNamed, automations, runs } from "./schema.js";

export type * from "./control-plane-types.js";

import type { ControlPlaneStore } from "./control-plane-types.js";

export function createPostgresControlPlaneStore(
  options: { readonly client?: DatabaseClient; readonly connectionString?: string } = {},
): ControlPlaneStore {
  const client =
    options.client ??
    createDatabaseClient(
      options.connectionString !== undefined ? { connectionString: options.connectionString } : {},
    );
  const ownsClient = options.client === undefined;

  return {
    async cancelRun(input) {
      return await cancelStoredRun(client, input);
    },
    async appendRunExecutionOutput(input) {
      await appendStoredRunExecutionOutput(client, input);
    },

    async advanceCronTriggerCursor(input) {
      return await advanceStoredCronTriggerCursor(client, input);
    },

    async close() {
      if (ownsClient) {
        await client.close();
      }
    },

    async commitDeployment(input) {
      return await commitStoredDeployment(client, input);
    },

    async completeAutomationCheck(input) {
      return await completeStoredAutomationCheck(client, input);
    },

    async getAutomationCheck(checkId) {
      return await getStoredAutomationCheck(client, checkId);
    },

    async listDueAutomationChecks(now, environment) {
      return await listStoredDueAutomationChecks(client, now, environment);
    },

    async recordApiContacts(input) {
      return await recordStoredApiContacts(client, input);
    },

    async commitRollbackDeployment(input) {
      return await commitStoredRollbackDeployment(client, input);
    },

    async cleanupMaintenanceData(input) {
      return await cleanupStoredMaintenanceData(client, input);
    },

    async countActiveRunsForAutomation(automationId, environment, excludeRunId) {
      return await countStoredActiveRunsForAutomation(
        client,
        automationId,
        environment,
        excludeRunId,
      );
    },

    async countDeadLetteredRunsSince(automationId, environment, since) {
      return await countStoredDeadLetteredRunsSince(client, automationId, environment, since);
    },

    async createMaintenanceRun(input) {
      return await createStoredMaintenanceRun(client, input);
    },

    async getLatestMaintenanceRun(environment) {
      return await getLatestStoredMaintenanceRun(client, environment);
    },

    async createNotificationRule(input) {
      return await createStoredNotificationRule(client, input);
    },

    async getNotificationRule(ruleId) {
      return await getStoredNotificationRule(client, ruleId);
    },

    async listNotificationRules(query) {
      return await listStoredNotificationRules(client, query);
    },

    async updateNotificationRule(input) {
      return await updateStoredNotificationRule(client, input);
    },

    async deleteNotificationRule(ruleId) {
      return await deleteStoredNotificationRule(client, ruleId);
    },

    async recordNotificationDelivery(input) {
      return await recordStoredNotificationDelivery(client, input);
    },

    async updateNotificationDelivery(input) {
      return await updateStoredNotificationDelivery(client, input);
    },

    async getLatestNotificationDeliveryForRule(ruleId, environment, automationId, eventType) {
      return await getLatestStoredNotificationDeliveryForRule(
        client,
        ruleId,
        environment,
        automationId,
        eventType,
      );
    },

    async listNotificationDeliveries(query) {
      return await listStoredNotificationDeliveries(client, query);
    },

    async createQueueMetricSample(input) {
      return await createStoredQueueMetricSample(client, input);
    },

    async listQueueMetricSamples(query) {
      return await listStoredQueueMetricSamples(client, query);
    },

    async expireRuns(input) {
      return await expireStoredRuns(client, input);
    },

    async deleteSecret(secretId) {
      return await deleteStoredSecret(client, secretId);
    },

    async findSecretDeclarationCollisions(input) {
      return await findStoredSecretDeclarationCollisions(client, input);
    },

    async getSecret(name, place) {
      return await getStoredSecret(client, name, place);
    },

    async listSecrets(environment, projectIds) {
      return await listStoredSecrets(client, environment, projectIds);
    },

    async upsertSecret(input) {
      return await upsertStoredSecret(client, input);
    },

    async resolveSecrets(secretIds) {
      return await resolveStoredSecrets(client, secretIds);
    },

    async findCredential(kind, name, place) {
      return await findStoredCredential(client, kind, name, place);
    },

    async credentialAccess(credentials) {
      return await storedCredentialAccess(client, credentials);
    },

    async setCredentialGrant(credential, grant) {
      await setStoredCredentialGrant(client, credential, grant);
    },

    async removeCredentialGrant(credential, subject) {
      return await removeStoredCredentialGrant(client, credential, subject);
    },

    async offerCredentialShare(input) {
      return await offerStoredCredentialShare(client, input);
    },

    async acceptCredentialShare(input) {
      return await acceptStoredCredentialShare(client, input);
    },

    async removeCredentialShare(shareId) {
      return await removeStoredCredentialShare(client, shareId);
    },

    async listCredentialShares(projectId) {
      return await listStoredCredentialShares(client, projectId);
    },

    async findDeploymentCredentials(declared) {
      return await findStoredDeploymentCredentials(client, declared);
    },

    async boundCredentials(deploymentId, projectId) {
      return await storedBoundCredentials(client, deploymentId, projectId);
    },

    async recordRunExecutionSecretUsages(input) {
      await recordStoredRunExecutionSecretUsages(client, input);
    },

    async beginConnectionAuthorization(input) {
      return await beginStoredConnectionAuthorization(client, input);
    },

    async consumeConnectionAuthorization(stateHash) {
      return await consumeStoredConnectionAuthorization(client, stateHash);
    },

    async deleteConnection(connectionId) {
      return await deleteStoredConnection(client, connectionId);
    },

    async getConnection(name, place) {
      return await getStoredConnection(client, name, place);
    },

    async getConnectionCredentials(name, place) {
      return await getStoredConnectionCredentials(client, name, place);
    },

    async listConnections(environment, projectIds) {
      return await listStoredConnections(client, environment, projectIds);
    },

    async markConnectionError(input) {
      return await markStoredConnectionError(client, input);
    },

    async recordRunExecutionConnectionUsages(input) {
      await recordStoredRunExecutionConnectionUsages(client, input);
    },

    async resolveConnectionToken(input) {
      return await resolveStoredConnectionToken(client, input);
    },

    async storeConnectionTokens(input) {
      return await storeStoredConnectionTokens(client, input);
    },

    async createDeploymentAuditEvent(input) {
      await createStoredDeploymentAuditEvent(client, input);
    },

    async setAutomationTimeoutGrant(input) {
      return await setStoredAutomationTimeoutGrant(client, input);
    },

    async getAutomationTimeoutGrant(input) {
      return await getStoredAutomationTimeoutGrant(client, input);
    },

    async deleteAutomationTimeoutGrant(input) {
      return await deleteStoredAutomationTimeoutGrant(client, input);
    },

    async listAutomationTimeoutGrants(environment) {
      return await listStoredAutomationTimeoutGrants(client, environment);
    },

    async listAutomationTimeoutGrantAuditEvents(input) {
      return await listStoredAutomationTimeoutGrantAuditEvents(client, input);
    },

    async getDeploymentById(deploymentId) {
      return await getDeploymentById(client, deploymentId);
    },

    async listDeploymentsByAutomationSlug(automationSlug, environment) {
      return await listStoredDeploymentsByAutomationSlug(client, automationSlug, environment);
    },

    async listActiveDeployments() {
      return await listStoredActiveDeployments(client);
    },

    async listDeploymentsForArtifactRetention(environment) {
      return await listStoredDeploymentsForArtifactRetention(client, environment);
    },

    async listDeploymentAuditEventsByAutomationSlug(
      automationSlug,
      environment: string,
      limit = 50,
    ) {
      return await listStoredDeploymentAuditEventsByAutomationSlug(
        client,
        automationSlug,
        environment,
        limit,
      );
    },

    async findAutomation(automationSlug) {
      const [row] = await client.db
        .select({
          automationId: automations.id,
          automationSlug: automations.slug,
          projectId: automations.projectId,
        })
        .from(automations)
        .where(automationNamed(automationSlug))
        .limit(1);
      return row ?? null;
    },

    async listAutomationChainDependents(automationSlug) {
      return await listStoredAutomationChainDependents(client, automationSlug);
    },
    async deleteAutomation(input) {
      return await deleteStoredAutomation(client, input);
    },

    async countProjectContents(projectId) {
      return await countStoredProjectContents(client, projectId);
    },

    async deleteProject(input) {
      return await deleteStoredProject(client, input);
    },

    async moveAutomation(input) {
      return await moveStoredAutomation(client, input);
    },

    async getChainTriggersForSource(sourceAutomationId, environment) {
      return await getStoredChainTriggersForSource(client, sourceAutomationId, environment);
    },

    async getActiveDeploymentBySlug(automationSlug, environment) {
      return await getStoredActiveDeploymentBySlug(client, automationSlug, environment);
    },

    async getAutomationTriggerBySlug(automationSlug, environment) {
      return await getStoredAutomationTriggerBySlug(client, automationSlug, environment);
    },

    async getWebhookTriggerByPath(webhookPath, environment) {
      return await getStoredWebhookTriggerByPath(client, webhookPath, environment);
    },

    async getDueCronTriggers(now, environment, limit = 50) {
      return await getStoredDueCronTriggers(client, now, environment, limit);
    },

    async createRun(input) {
      return await createStoredRun(client, input);
    },

    async createChainJoinRun(input) {
      return await createStoredChainJoinRun(client, input);
    },

    async findSucceededChainSourceRuns(input) {
      return await findStoredSucceededChainSourceRuns(client, input);
    },

    async markRunTerminalPending(runId) {
      await client.db.update(runs).set({ terminalPending: true }).where(eq(runs.id, runId));
    },
    async recordRunEnqueueError(runId, message) {
      await client.db
        .update(runs)
        .set({
          errorCode: "QUEUE_ENQUEUE_FAILED",
          errorClassification: "retryable",
          errorMessage: message,
          updatedAt: new Date(),
        })
        .where(and(eq(runs.id, runId), eq(runs.status, "queued")));
    },
    async getRun(runId) {
      return await getStoredRun(client, runId);
    },

    async listAutomationState(input) {
      return await listStoredAutomationState(client, input);
    },

    async listRunSteps(input) {
      return await listStoredRunSteps(client, input);
    },

    async getRunStepTotals(input) {
      return await getStoredRunStepTotals(client, input);
    },

    async getAutomationStateValue(input) {
      return await getStoredAutomationStateValue(client, input);
    },

    async setAutomationStateValue(input) {
      return await setStoredAutomationStateValue(client, input);
    },

    async claimAutomationStateKey(input) {
      return await claimStoredAutomationStateKey(client, input);
    },

    async setRunStepResult(input) {
      return await setStoredRunStepResult(client, input);
    },

    async startRunStep(input) {
      return await startStoredRunStep(client, input);
    },

    async deleteAutomationStateValue(input) {
      return await deleteStoredAutomationStateValue(client, input);
    },

    async createRunExecution(input) {
      await createStoredRunExecution(client, input);
    },

    async completeRunExecution(input) {
      await completeStoredRunExecution(client, input);
    },

    async markRunExecutionReady(input) {
      await markStoredRunExecutionReady(client, input);
    },

    async updateRunExecutionHeartbeat(input) {
      return await updateStoredRunExecutionHeartbeat(client, input);
    },

    async listChildRuns(input) {
      return await listStoredChildRuns(client, input);
    },

    async listDueSleepingRuns(input) {
      return await listStoredDueSleepingRuns(client, input);
    },

    async listDueWaitingRuns(input) {
      return await listStoredDueWaitingRuns(client, input);
    },

    async listQueuedRuns(input) {
      return await listStoredQueuedRuns(client, input);
    },

    async listWaitingEventRuns(input) {
      return await listStoredWaitingEventRuns(client, input);
    },

    async resumeWaitingRun(input) {
      return await resumeStoredWaitingRun(client, input);
    },

    async reassignApproval(input) {
      return await reassignStoredApproval(client, input);
    },

    async resolveApprovalAssignee(request) {
      return await resolveApprovalAssignee(client, request);
    },

    async personMayRead(userId, target) {
      return await personMayRead(client, userId, target);
    },

    async updateRunState(input) {
      await updateStoredRunState(client, input);
    },

    async createTriggerAuditEvent(input) {
      await createStoredTriggerAuditEvent(client, input);
    },

    async listTriggerAuditEventsByAutomationSlug(automationSlug, environment: string, limit = 50) {
      return await listStoredTriggerAuditEventsByAutomationSlug(
        client,
        automationSlug,
        environment,
        limit,
      );
    },

    async updateAutomationTriggerStatus(input) {
      return await updateStoredAutomationTriggerStatus(client, input);
    },
  };
}
