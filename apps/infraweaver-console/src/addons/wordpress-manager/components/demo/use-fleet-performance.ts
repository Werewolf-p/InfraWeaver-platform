"use client";

import { useQuery } from "@tanstack/react-query";
import type { FleetPageSpeed } from "../../lib/fleet/pagespeed";
import type { FleetPerformance } from "../../lib/fleet/performance";

/**
 * Live fleet-performance hook — the real, secure replacement for the seeded
 * performance dummy data. Reads `/api/wordpress/fleet/performance`, which returns
 * the real PHP/health posture plus the optional Google PageSpeed roll-up (which
 * degrades honestly when unconfigured). React Query dedupes/caches on top of the
 * server's SWR snapshot caches. The response types are erased `import type`s from
 * the server-only lib modules, so no server code is pulled into the client bundle.
 */
export interface FleetPerformanceResponse {
  readonly perf: FleetPerformance;
  readonly pagespeed: FleetPageSpeed;
}

export interface FleetPerformanceState {
  readonly data: FleetPerformanceResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  reload(): void;
}

async function fetchFleetPerformance(): Promise<FleetPerformanceResponse> {
  const res = await fetch("/api/wordpress/fleet/performance");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Sign in to view fleet performance.");
    if (res.status === 403) throw new Error("You don't have access to the fleet.");
    throw new Error(`Fleet performance request failed (${res.status}).`);
  }
  return (await res.json()) as FleetPerformanceResponse;
}

export function useFleetPerformance(): FleetPerformanceState {
  const query = useQuery({
    queryKey: ["wordpress-fleet-performance"],
    queryFn: fetchFleetPerformance,
    // PageSpeed is SWR-cached ~10 min server-side; poll gently on top of that.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error ? (query.error instanceof Error ? query.error.message : "Something went wrong.") : null,
    reload: () => void query.refetch(),
  };
}
