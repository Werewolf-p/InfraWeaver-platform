import { MutationCache, QueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "@/lib/notify";
import { classifyClientError } from "@/lib/error-taxonomy";

export function createQueryClient() {
  return new QueryClient({
    // Safety net for the ~29 call sites that use raw useMutation without their
    // own onError — those writes previously failed SILENTLY. Only fires when the
    // mutation defined no onError of its own, so it never double-toasts.
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (mutation.options.onError) return;
        toast.error(classifyClientError(error).title);
      },
    }),
    defaultOptions: {
      queries: {
        // Single-replica homelab backends can't absorb a thundering herd of
        // refetches every time a tab regains focus. Reconnect refetch stays on.
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
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
