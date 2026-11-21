import { type QueryClient, useQuery } from "@tanstack/react-query";

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

export function useAuthStatus() {
  const { authRevision } = useDashboardSession();
  return useQuery({
    queryFn: () => sessionApi.getAuthStatus(),
    queryKey: ["auth-status", authRevision],
    refetchInterval: 60_000,
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
