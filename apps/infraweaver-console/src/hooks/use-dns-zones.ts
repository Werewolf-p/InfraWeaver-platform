"use client";

import { useQuery } from "@tanstack/react-query";
import type { DnsZoneSummary, DnsZonesResponse } from "@/app/api/dns/zones/route";

export type { DnsZoneSummary } from "@/app/api/dns/zones/route";

interface UseDnsZonesResult {
  zones: DnsZoneSummary[];
  defaultZoneId: string | null;
  /** True once more than one manageable zone exists — when a selector is useful. */
  hasMultipleZones: boolean;
  isLoading: boolean;
}

/**
 * The set of Cloudflare zones the configured API token manages. Shared by every
 * DNS-configuration surface so they all offer the same dynamic domain list. An
 * unconfigured token or a single zone yields `hasMultipleZones: false`, letting
 * callers keep their single-zone behavior.
 */
export function useDnsZones(): UseDnsZonesResult {
  const { data, isLoading } = useQuery({
    queryKey: ["dns", "zones"],
    queryFn: async () => {
      const res = await fetch("/api/dns/zones", { cache: "no-store" });
      const payload = (await res.json().catch(() => ({ zones: [], defaultZoneId: null }))) as DnsZonesResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Failed to load DNS zones");
      return payload;
    },
    staleTime: 5 * 60 * 1000,
  });

  const zones = data?.zones ?? [];
  return {
    zones,
    defaultZoneId: data?.defaultZoneId ?? null,
    hasMultipleZones: zones.length > 1,
    isLoading,
  };
}
