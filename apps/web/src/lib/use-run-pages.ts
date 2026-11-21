import { useInfiniteQuery } from "@tanstack/react-query";

import type { RunListItem, RunStatus, RunsResponse } from "./api";
import { useDashboardClient } from "./dashboard-client";

const PAGE_SIZE = 100;

export interface RunPagesFilter {
  readonly approvalOnly?: boolean;
  readonly automation?: string;
  readonly failedOnly?: boolean;
  readonly statuses?: readonly RunStatus[];
}

export interface RunPages {
  readonly runs: readonly RunListItem[] | undefined;
  readonly complete: boolean;
  readonly error: Error | null;
  readonly retry: () => void;
  readonly loadOlder: () => void;
  readonly loadingOlder: boolean;
  readonly olderError: Error | null;
}

export function useRunPages(filter: RunPagesFilter): RunPages {
  const { api, queryScope } = useDashboardClient();
  const query = useInfiniteQuery({
    getNextPageParam: (page: RunsResponse) => page.nextCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.listRuns({
        ...filter,
        limit: PAGE_SIZE,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    queryKey: ["run-pages", filter, ...queryScope],
    refetchInterval: 5_000,
  });
  return {
    complete: query.data !== undefined && !query.hasNextPage,
    error: query.data === undefined ? query.error : null,
    loadOlder: () => void query.fetchNextPage(),
    loadingOlder: query.isFetchingNextPage,
    olderError: query.isFetchNextPageError ? query.error : null,
    retry: () => void query.refetch(),
    runs: query.data?.pages.flatMap((page) => page.runs),
  };
}
