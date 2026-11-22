import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type { RunListItem, RunState, RunsResponse } from "./api";
import { useDashboardClient } from "./dashboard-client";

const PAGE_SIZE = 100;
type RunHistory = InfiniteData<RunsResponse>;

export interface RunPagesFilter {
  readonly approvalOnly?: boolean;
  readonly automation?: string;
  readonly queuedSince?: string;
  readonly topLevelOnly?: boolean;
  readonly states?: readonly RunState[];
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
  const client = useQueryClient();
  const historyKey = ["run-history", filter, ...queryScope];
  const listRuns = (cursor: string | null) =>
    api.listRuns({ ...filter, limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) });
  const newest = useQuery({
    queryFn: () => listRuns(null),
    queryKey: ["run-head", filter, ...queryScope],
    refetchInterval: 5_000,
  });
  const history = useInfiniteQuery({
    enabled: false,
    getNextPageParam: (page: RunsResponse) => page.nextCursor,
    initialPageParam: null,
    queryFn: ({ pageParam }: { readonly pageParam: string | null }) => listRuns(pageParam),
    queryKey: historyKey,
  });
  const page = newest.data;
  const joined = joinedHistory(page, history.data);
  const hasOlder = page?.nextCursor != null && (joined === undefined || history.hasNextPage);
  return {
    complete: page !== undefined && !hasOlder,
    error: page === undefined ? newest.error : null,
    loadOlder: () => {
      if (!hasOlder || page === undefined) return;
      const loaded = client.getQueryData<RunHistory>(historyKey);
      const reseed = joinedHistory(page, loaded) === undefined;
      if (reseed) {
        client.setQueryData<RunHistory>(historyKey, { pageParams: [null], pages: [page] });
      }
      void history.fetchNextPage({ cancelRefetch: reseed });
    },
    loadingOlder: joined !== undefined && history.isFetchingNextPage,
    olderError: joined !== undefined && history.isFetchNextPageError ? history.error : null,
    retry: () => void newest.refetch(),
    runs: page === undefined ? undefined : mergeRunPages(page, joined?.pages ?? []),
  };
}

function joinedHistory(newest: RunsResponse | undefined, history: RunHistory | undefined) {
  const anchor = history?.pages[0]?.runs[0];
  const boundary = newest?.runs.at(-1);
  if (newest?.nextCursor == null || anchor === undefined || boundary === undefined)
    return undefined;
  return boundary.queuedAt < anchor.queuedAt ||
    newest.runs.some((run) => run.runId === anchor.runId)
    ? history
    : undefined;
}

function mergeRunPages(
  newest: RunsResponse,
  history: readonly RunsResponse[],
): readonly RunListItem[] {
  const boundary = newest.runs.at(-1);
  if (boundary === undefined || history.length === 0) return newest.runs;
  const runs = new Map(newest.runs.map((run) => [run.runId, run]));
  for (const page of history) {
    for (const run of page.runs) {
      if (run.queuedAt <= boundary.queuedAt && !runs.has(run.runId)) runs.set(run.runId, run);
    }
  }
  return [...runs.values()];
}
