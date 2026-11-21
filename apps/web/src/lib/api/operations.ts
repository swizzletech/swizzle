import type { AuditResponse, HealthResponse, OperationsSummaryResponse } from "../api";
import { request } from "./request";

export function operationsCalls(environment: string) {
  return {
    async getHealth() {
      return await request<HealthResponse>("/health");
    },

    async getOperationsSummary(targetEnvironment = environment) {
      return await request<OperationsSummaryResponse>(
        `/ops/summary?environment=${encodeURIComponent(targetEnvironment)}`,
        undefined,
      );
    },

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
