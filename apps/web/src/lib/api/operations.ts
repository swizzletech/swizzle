// The instance's health, its operations summary and the audit history.

import type { AuditResponse, HealthResponse, OperationsSummaryResponse } from "../api";
import { request } from "./request";

export function operationsCalls(environment: string) {
  return {
    /** The public liveness answer, which names the platform version. */
    async getHealth() {
      return await request<HealthResponse>("/health");
    },

    async getOperationsSummary(targetEnvironment = environment) {
      return await request<OperationsSummaryResponse>(
        `/ops/summary?environment=${encodeURIComponent(targetEnvironment)}`,
        undefined,
      );
    },

    /** Newest first, as far as the caller may read; `actor` names a person or service account by id. */
    async listAudit(filters: {
      readonly actor?: string;
      readonly automation?: string;
      readonly environment?: string;
      readonly worker?: string;
      readonly limit?: number;
    }) {
      const query = new URLSearchParams();
      if (filters.environment !== undefined) query.set("environment", filters.environment);
      if (filters.automation !== undefined) query.set("automation", filters.automation);
      if (filters.worker !== undefined) query.set("worker", filters.worker);
      if (filters.actor !== undefined) query.set("actor", filters.actor);
      if (filters.limit !== undefined) query.set("limit", String(filters.limit));
      return await request<AuditResponse>(`/audit?${query.toString()}`);
    },
  };
}
