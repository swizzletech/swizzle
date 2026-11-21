import { type QueryClient, useQuery } from "@tanstack/react-query";

import { ApiError } from "./api";
import { sessionApi } from "./api/account";
import { useDashboardClient, useDashboardSession } from "./dashboard-client";

export function useOverview() {
  const { api, queryScope } = useDashboardClient();
  return useQuery({
    queryFn: () => api.getOverview(),
    queryKey: ["overview", ...queryScope],
    refetchInterval: 15_000,
  });
}

export function useAutomations() {
  const { api, queryScope } = useDashboardClient();
  return useQuery({
    queryFn: async () => (await api.listAutomations()).automations,
    queryKey: ["automations", ...queryScope],
    refetchInterval: 15_000,
  });
}

export function useFolders() {
  const { api, queryScope } = useDashboardClient();
  return useQuery({
    queryFn: () => api.listAutomationFolders(),
    queryKey: ["folders", ...queryScope],
  });
}

export function useDirectory() {
  const { api, queryScope } = useDashboardClient();
  return useQuery({
    queryFn: () => api.directory(),
    queryKey: ["directory", ...queryScope],
  });
}

export async function refreshAll(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries();
}

export function useProjects() {
  const { api, authRevision } = useDashboardClient();
  return useQuery({
    queryFn: async () => (await api.listProjects()).projects,
    queryKey: ["projects", authRevision],
  });
}

const AUTH_STATUS_INTERVAL_MS = 60_000;

export function isAuthStatusRateLimited(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 429;
}

export function useAuthStatus() {
  const { authRevision } = useDashboardSession();
  return useQuery({
    queryFn: ({ signal }) => sessionApi.getAuthStatus(signal),
    queryKey: ["auth-status", authRevision],
    refetchInterval: AUTH_STATUS_INTERVAL_MS,
    retry: (failureCount, error) => isAuthStatusRateLimited(error) || failureCount < 1,
    retryDelay: (_failureCount, error) => {
      if (!isAuthStatusRateLimited(error)) return 1_000;
      const header = error.retryAfter ?? "";
      if (!/^\d+$/u.test(header)) return AUTH_STATUS_INTERVAL_MS;
      return Math.min(Math.max(Number(header) * 1_000, 1_000), 2_147_483_647);
    },
    staleTime: 30_000,
  });
}

export function useMe() {
  return useAuthStatus().data?.user ?? null;
}

export function useProjectAccess(project: string) {
  const { api, authRevision } = useDashboardClient();
  return useQuery({
    queryFn: () => api.getProjectAccess(project),
    queryKey: ["project-access", project, authRevision],
  });
}
