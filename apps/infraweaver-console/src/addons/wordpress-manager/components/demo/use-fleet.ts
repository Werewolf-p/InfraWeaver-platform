"use client";

import { useQuery } from "@tanstack/react-query";
import type { FleetData } from "../../lib/fleet/types";

/**
 * Live fleet roll-up hook — the real, secure replacement for the seeded
 * `dummy-data.ts`. Reads `/api/wordpress/fleet`, which aggregates provisioned
 * sites + signed Connector links + in-pod wp-cli overviews. React Query caches
 * and dedupes on top of the server's SWR snapshot cache.
 */
export interface FleetState {
  readonly data: FleetData | null;
  readonly loading: boolean;
  readonly error: string | null;
  reload(): void;
}

async function fetchFleet(): Promise<FleetData> {
  const res = await fetch("/api/wordpress/fleet");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Sign in to view the fleet.");
    if (res.status === 403) throw new Error("You don't have access to the fleet.");
    throw new Error(`Fleet request failed (${res.status}).`);
  }
  return (await res.json()) as FleetData;
}

export function useFleet(): FleetState {
  const query = useQuery({
    queryKey: ["wordpress-fleet"],
    queryFn: fetchFleet,
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error ? (query.error instanceof Error ? query.error.message : "Something went wrong.") : null,
    reload: () => void query.refetch(),
  };
}
