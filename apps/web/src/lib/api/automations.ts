// Automations: the overview, details, flow, source and README, folders, triggers and rollback.

import type {
  AssignAutomationFolderResponse,
  AutomationDetailResponse,
  AutomationFolderResponse,
  AutomationFoldersResponse,
  AutomationMermaidResponse,
  AutomationReadmeResponse,
  AutomationSourceResponse,
  AutomationsResponse,
  DeploymentResponse,
  NoContentResponse,
  OverviewResponse,
  StepReachResponse,
  TriggerRunResponse,
  TriggerStatusResponse,
} from "../api";
import { request } from "./request";

export function automationsCalls(environment: string) {
  return {
    async assignAutomationFolder(automationSlug: string, folderId: string | null) {
      return await request<AssignAutomationFolderResponse>(
        `/automations/${encodeURIComponent(automationSlug)}/folder`,
        {
          body: JSON.stringify({ folderId }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        },
      );
    },

    async createAutomationFolder(name: string) {
      return await request<AutomationFolderResponse>("/automation-folders", {
        body: JSON.stringify({ name }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    },

    async renameAutomationFolder(folderId: string, name: string) {
      return await request<AutomationFolderResponse>(
        `/automation-folders/${encodeURIComponent(folderId)}`,
        {
          body: JSON.stringify({ name }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        },
      );
    },

    async deleteAutomationFolder(folderId: string) {
      await request<NoContentResponse>(`/automation-folders/${encodeURIComponent(folderId)}`, {
        method: "DELETE",
      });
    },

    async getAutomationDetail(automationSlug: string, targetEnvironment = environment) {
      return await request<AutomationDetailResponse>(
        `/dashboard/automations/${encodeURIComponent(automationSlug)}?environment=${encodeURIComponent(targetEnvironment)}`,
        undefined,
      );
    },

    async rollbackDeployment(
      automationSlug: string,
      targetDeploymentId: string,
      targetEnvironment = environment,
    ) {
      return await request<DeploymentResponse>(
        `/automations/${encodeURIComponent(automationSlug)}/rollback?environment=${encodeURIComponent(targetEnvironment)}`,
        {
          body: JSON.stringify({ targetDeploymentId }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    },

    /** The flow.mermaid of the active deployment or the one named. */
    async getMermaidDiagram(automationSlug: string, deploymentId?: string) {
      const query = new URLSearchParams({ environment });
      if (deploymentId !== undefined) query.set("deployment", deploymentId);
      return await request<AutomationMermaidResponse>(
        `/dashboard/automations/${encodeURIComponent(automationSlug)}/mermaid?${query.toString()}`,
        undefined,
      );
    },

    /** The entrypoint and its step sites, of the active deployment or the one named. */
    async getAutomationSource(automationSlug: string, deploymentId?: string) {
      const query = new URLSearchParams({ environment });
      if (deploymentId !== undefined) query.set("deployment", deploymentId);
      return await request<AutomationSourceResponse>(
        `/dashboard/automations/${encodeURIComponent(automationSlug)}/source?${query.toString()}`,
        undefined,
      );
    },

    /** How many of the last 50 runs reached each step. */
    async getStepReach(automationSlug: string) {
      return await request<StepReachResponse>(
        `/dashboard/automations/${encodeURIComponent(automationSlug)}/step-reach?environment=${encodeURIComponent(environment)}`,
        undefined,
      );
    },

    async getAutomationReadme(automationSlug: string, targetEnvironment = environment) {
      return await request<AutomationReadmeResponse>(
        `/dashboard/automations/${encodeURIComponent(automationSlug)}/readme?environment=${encodeURIComponent(targetEnvironment)}`,
        undefined,
      );
    },

    async getOverview() {
      return await request<OverviewResponse>(
        `/dashboard/overview?environment=${encodeURIComponent(environment)}`,
      );
    },

    /** Starts a manual run now; it gets a new id and reads as `manual`. */
    async startRun(automationSlug: string, payload: unknown) {
      return await request<TriggerRunResponse>(
        `/automations/${encodeURIComponent(automationSlug)}/runs?environment=${encodeURIComponent(environment)}`,
        {
          body: JSON.stringify(payload ?? {}),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    },

    async listAutomations(targetEnvironment = environment) {
      return await request<AutomationsResponse>(
        `/dashboard/automations?environment=${encodeURIComponent(targetEnvironment)}`,
        undefined,
      );
    },

    async listAutomationFolders() {
      return await request<AutomationFoldersResponse>("/automation-folders", undefined);
    },

    async pauseTrigger(automationSlug: string, targetEnvironment = environment) {
      return await request<TriggerStatusResponse>(
        `/automations/${encodeURIComponent(automationSlug)}/trigger/pause?environment=${encodeURIComponent(targetEnvironment)}`,
        {
          method: "POST",
        },
      );
    },

    async resumeTrigger(automationSlug: string, targetEnvironment = environment) {
      return await request<TriggerStatusResponse>(
        `/automations/${encodeURIComponent(automationSlug)}/trigger/resume?environment=${encodeURIComponent(targetEnvironment)}`,
        {
          method: "POST",
        },
      );
    },
  };
}
