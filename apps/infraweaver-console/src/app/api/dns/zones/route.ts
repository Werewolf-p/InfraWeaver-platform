import { NextResponse } from "next/server";
import { cloudflareConfigured, defaultZoneId, listZones } from "@/lib/cloudflare";
import { withAuth } from "@/lib/with-auth";

export interface DnsZoneSummary {
  id: string;
  name: string;
}

export interface DnsZonesResponse {
  zones: DnsZoneSummary[];
  defaultZoneId: string | null;
}

export const GET = withAuth({ permission: "config:read" }, async () => {
  // Backward compatible: an unconfigured token yields no manageable zones, so
  // the client falls back to its single-zone behavior.
  if (!cloudflareConfigured()) {
    return NextResponse.json({ zones: [], defaultZoneId: null } satisfies DnsZonesResponse);
  }

  const zones = await listZones();
  const summaries = zones
    .map((zone) => ({ id: zone.id, name: zone.name }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return NextResponse.json({
    zones: summaries,
    defaultZoneId: defaultZoneId() ?? null,
  } satisfies DnsZonesResponse);
});
