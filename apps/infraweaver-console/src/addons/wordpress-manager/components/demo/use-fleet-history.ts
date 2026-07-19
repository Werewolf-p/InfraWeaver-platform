"use client";

import { useQuery } from "@tanstack/react-query";
import type { FleetHistory } from "../../lib/fleet/history";

/**
 * Fleet trend hook — the Prometheus-backed companion to `useFleet`. Reads
 * `/api/wordpress/fleet/history`, which returns `available:false` (with a reason)
 * whenever Prometheus is unconfigured/unreachable, so this hook never needs to
 * fabricate a fallback. A type-only import of `FleetHistory` from the server
 * module is erased at build time, so the `server-only` guard is never tripped.
 */
export interface FleetHistoryState {
  readonly data: FleetHistory | null;
  readonly loading: boolean;
  readonly error: string | null;
  reload(): void;
}

async function fetchFleetHistory(): Promise<FleetHistory> {
  const res = await fetch("/api/wordpress/fleet/history");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Sign in to view fleet trends.");
    if (res.status === 403) throw new Error("You don't have access to fleet trends.");
    throw new Error(`Fleet history request failed (${res.status}).`);
  }
  return (await res.json()) as FleetHistory;
}

export function useFleetHistory(): FleetHistoryState {
  const query = useQuery({
    queryKey: ["wordpress-fleet-history"],
    queryFn: fetchFleetHistory,
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error ? (query.error instanceof Error ? query.error.message : "Something went wrong.") : null,
    reload: () => void query.refetch(),
  };
}
