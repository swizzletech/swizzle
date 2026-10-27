import { type QueryClient, useQuery } from "@tanstack/react-query";

import { sessionApi } from "./api/account";
import { useDashboardClient, useDashboardSession } from "./dashboard-client";

// Reads more than one page shares. Keys start with the read's name and end with the client's
// query scope, so switching the environment or the session refetches everything.

/** The Overview's read model, also used by the sidebar's count. */
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

/** The folders the viewer sees, with why they may not organize one or make a new one. */
export function useFolders() {
  const { api, queryScope } = useDashboardClient();
  return useQuery({
    queryFn: () => api.listAutomationFolders(),
    queryKey: ["folders", ...queryScope],
  });
}

/** The people and teams of the instance the viewer may hand a right or an approval to. */
export function useDirectory() {
  const { api, queryScope } = useDashboardClient();
  return useQuery({
    queryFn: () => api.directory(),
    queryKey: ["directory", ...queryScope],
  });
}

/** After any change the owner makes, every read may tell a different story; refetch them all. */
export async function refreshAll(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries();
}

/** The projects the signed-in person sees, with their role and each project's protected environments. */
export function useProjects() {
  const { api, authRevision } = useDashboardClient();
  return useQuery({
    queryFn: async () => (await api.listProjects()).projects,
    queryKey: ["projects", authRevision],
  });
}

/** Who is signed in and whether the instance sends mail; AppShell gates every page on it. */
export function useAuthStatus() {
  const { authRevision } = useDashboardSession();
  return useQuery({
    queryFn: () => sessionApi.getAuthStatus(),
    queryKey: ["auth-status", authRevision],
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** The signed-in person; null until the status answers. */
export function useMe() {
  return useAuthStatus().data?.user ?? null;
}

/** A project's holders and grants, for its admins. */
export function useProjectAccess(project: string) {
  const { api, authRevision } = useDashboardClient();
  return useQuery({
    queryFn: () => api.getProjectAccess(project),
    queryKey: ["project-access", project, authRevision],
  });
}
