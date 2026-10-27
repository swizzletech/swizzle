import { QueryClient } from "@tanstack/react-query";

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        retry: 0,
      },
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 5_000,
      },
    },
  });
}
