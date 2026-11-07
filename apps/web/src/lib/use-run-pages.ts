// A run list that grows by cursor: the newest page polls, Load older asks for the next one, and
// every run the filter matches stays reachable. The poll refetches the loaded pages in order, each
// from the previous page's cursor, so a run that arrives between polls shifts them without a gap.

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
  /** The runs loaded so far, newest first; undefined until the first page arrives. */
  readonly runs: readonly RunListItem[] | undefined;
  /** Whether the list reached the filter's oldest run. */
  readonly complete: boolean;
  readonly error: Error | null;
  readonly retry: () => void;
  readonly loadOlder: () => void;
  readonly loadingOlder: boolean;
  /** Why the last Load older failed; the runs already loaded stay. */
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
