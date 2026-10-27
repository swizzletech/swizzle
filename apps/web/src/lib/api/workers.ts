// The machines that run automations: enrollment and revocation.

import type {
  WorkerEnrollmentResponse,
  WorkerGrants,
  WorkerResponse,
  WorkersResponse,
} from "../api";
import { request } from "./request";

export function workersCalls() {
  return {
    async listWorkers() {
      return await request<WorkersResponse>("/workers");
    },

    async createWorker(input: WorkerGrants & { readonly name: string }) {
      return await request<WorkerEnrollmentResponse>("/workers/enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    },

    async revokeWorker(id: string) {
      return await request<WorkerResponse>(`/workers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
  };
}
