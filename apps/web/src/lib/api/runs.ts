// Runs: the list, one run's detail, steps and diagnosis, cancel, and approval decisions.

import type {
  ApprovalAssigneeResponse,
  CancelRunResponse,
  DashboardRunResponse,
  ResumeRunResponse,
  RunDiagnosisResponse,
  RunStatus,
  RunStepsResponse,
  RunsResponse,
  TriggerRunResponse,
  TriggerType,
} from "../api";
import { request } from "./request";

export function runsCalls(environment: string) {
  return {
    async getRunDetail(runId: string) {
      return await request<DashboardRunResponse>(
        `/dashboard/runs/${encodeURIComponent(runId)}`,
        undefined,
      );
    },

    async listRunSteps(runId: string) {
      return await request<RunStepsResponse>(
        `/dashboard/runs/${encodeURIComponent(runId)}/steps`,
        undefined,
      );
    },

    async replayRun(runId: string) {
      return await request<TriggerRunResponse>(`/runs/${encodeURIComponent(runId)}/replay`, {
        method: "POST",
      });
    },

    async cancelRun(runId: string) {
      return await request<CancelRunResponse>(`/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      });
    },

    async getRunDiagnosis(runId: string) {
      return await request<RunDiagnosisResponse>(`/runs/${encodeURIComponent(runId)}/diagnosis`);
    },

    /** Approves or rejects a run waiting at an approval step, as the signed-in person. */
    async decideApproval(
      runId: string,
      stepKey: string,
      decision: { readonly approved: boolean; readonly comment?: string },
    ) {
      return await request<ResumeRunResponse>(
        `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(stepKey)}`,
        {
          body: JSON.stringify(decision),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    },

    /** Hands an open approval to a person (by email) or a team (by name), with the reason. */
    async reassignApproval(
      runId: string,
      stepKey: string,
      to: ({ readonly user: string } | { readonly team: string }) & { readonly reason: string },
    ) {
      return await request<ApprovalAssigneeResponse>(
        `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(stepKey)}/assignee`,
        {
          body: JSON.stringify(to),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        },
      );
    },

    async listRuns(filters: {
      /** Only runs waiting for the owner's approval. */
      readonly approvalOnly?: boolean;
      readonly automation?: string;
      readonly environment?: string;
      readonly limit?: number;
      readonly parentRunId?: string;
      readonly statuses?: readonly RunStatus[];
      readonly topLevelOnly?: boolean;
      readonly triggerType?: TriggerType;
    }) {
      const query = new URLSearchParams();
      query.set("environment", filters.environment ?? environment);
      if (filters.automation) {
        query.set("automation", filters.automation);
      }
      if (filters.approvalOnly === true) {
        query.set("approvalOnly", "true");
      }
      if (filters.statuses !== undefined && filters.statuses.length > 0) {
        query.set("status", filters.statuses.join(","));
      }
      if (filters.triggerType) {
        query.set("triggerType", filters.triggerType);
      }
      if (filters.limit !== undefined) {
        query.set("limit", String(filters.limit));
      }
      if (filters.parentRunId) {
        query.set("parentRunId", filters.parentRunId);
      }
      if (filters.topLevelOnly !== undefined) {
        query.set("topLevelOnly", String(filters.topLevelOnly));
      }

      return await request<RunsResponse>(`/dashboard/runs?${query.toString()}`);
    },
  };
}
