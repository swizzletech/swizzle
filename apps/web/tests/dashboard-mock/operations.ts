import type { MockRoute } from "./route";

export function operations({ is, json }: MockRoute) {
  if (is("GET", /^\/ops\/summary$/u)) {
    return json({
      maintenance: { latestRun: null, staleAfterMs: 0, state: "healthy" },
      onlineWorkers: 1,
      services: {
        heartbeatTtlMs: 30_000,
        instances: [],
        summary: [{ alive: 1, service: "scheduler", stale: 0, total: 1 }],
      },
    });
  }
  return undefined;
}
