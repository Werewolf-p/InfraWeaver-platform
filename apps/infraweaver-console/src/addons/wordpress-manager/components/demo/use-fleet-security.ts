"use client";

import { useQuery } from "@tanstack/react-query";
import type { FleetSecurity } from "../../lib/fleet/security-agg";

/**
 * Live fleet-security hook — the real, secure replacement for the seeded WAF /
 * CVE / malware demo data. Reads `/api/wordpress/fleet/security`, which rolls up
 * the fleet's real posture (pending core/plugin updates, quarantined/rejecting
 * signed links, offline sites) and honestly reports the vulnerability + WAF feeds
 * as unconfigured. React Query caches and dedupes on top of the server's SWR
 * snapshot cache.
 */
export interface FleetSecurityState {
  readonly data: FleetSecurity | null;
  readonly loading: boolean;
  readonly error: string | null;
  reload(): void;
}

async function fetchFleetSecurity(): Promise<FleetSecurity> {
  const res = await fetch("/api/wordpress/fleet/security");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Sign in to view fleet security.");
    if (res.status === 403) throw new Error("You don't have access to the fleet.");
    throw new Error(`Fleet security request failed (${res.status}).`);
  }
  return (await res.json()) as FleetSecurity;
}

export function useFleetSecurity(): FleetSecurityState {
  const query = useQuery({
    queryKey: ["wordpress-fleet-security"],
    queryFn: fetchFleetSecurity,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error ? (query.error instanceof Error ? query.error.message : "Something went wrong.") : null,
    reload: () => void query.refetch(),
  };
}
