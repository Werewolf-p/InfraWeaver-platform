import { QueryClient, keepPreviousData } from "@tanstack/react-query";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof Response && error.status < 500) return false;
          if (error && typeof error === "object" && "status" in error) {
            const status = (error as { status: number }).status;
            if (status >= 400 && status < 500) return false;
          }
          return failureCount < 3;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30_000),
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        // Keep the previous successful data on screen while a refetch is in
        // flight (refresh, refetchInterval, query-key changes) instead of
        // dropping back to loading/empty. Makes refreshes far less distracting —
        // existing data stays put and only updates once new data arrives.
        placeholderData: keepPreviousData,
      },
      mutations: {
        retry: 1,
        retryDelay: 2000,
      },
    },
  });
}
