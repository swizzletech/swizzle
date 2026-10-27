import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import {
  getAutomationDetail,
  listAutomationSummaries,
  listDeploymentChanges,
} from "./dashboard-automations.js";
import { listServiceHeartbeats, upsertServiceHeartbeat } from "./dashboard-heartbeats.js";
import { getMermaidDiagram } from "./dashboard-mermaid.js";
import { countRunsSince, listQueuedRuns, listRuns } from "./dashboard-runs.js";
import { countStepReach, listRunSteps } from "./dashboard-steps.js";
import type { DashboardStore } from "./dashboard-types.js";

export function createDashboardStore(
  options: { readonly client?: DatabaseClient; readonly connectionString?: string } = {},
): DashboardStore {
  const client =
    options.client ??
    createDatabaseClient(
      options.connectionString !== undefined ? { connectionString: options.connectionString } : {},
    );
  const ownsClient = options.client === undefined;

  return {
    async close() {
      if (ownsClient) {
        await client.close();
      }
    },

    async countRunsSince(environment, since, scope) {
      return await countRunsSince(client, environment, since, scope);
    },

    async countStepReach(automationSlug, environment, limit) {
      return await countStepReach(client, automationSlug, environment, limit);
    },

    async getAutomationDetail(automationSlug, environment, scope) {
      return await getAutomationDetail(client, automationSlug, environment, scope);
    },

    async getMermaidDiagram(automationSlug, environment) {
      return await getMermaidDiagram(client, automationSlug, environment);
    },

    async listAutomationSummaries(environment, scope) {
      return await listAutomationSummaries(client, environment, scope);
    },

    async listDeploymentChanges(environment, since, limit, scope) {
      return await listDeploymentChanges(client, environment, since, limit, scope);
    },

    async listRuns(query) {
      return await listRuns(client, query);
    },

    async listQueuedRuns(environment, scope) {
      return await listQueuedRuns(client, environment, scope);
    },

    async listRunSteps(runId) {
      return await listRunSteps(client, { runId });
    },

    async listServiceHeartbeats(environment, service) {
      return await listServiceHeartbeats(client, environment, service);
    },

    async upsertServiceHeartbeat(input) {
      return await upsertServiceHeartbeat(client, input);
    },
  };
}
