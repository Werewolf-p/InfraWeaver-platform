import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { cloudflareConfigured, defaultZoneId, listZones } from "@/lib/cloudflare";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

export interface DnsZoneSummary {
  id: string;
  name: string;
}

export interface DnsZonesResponse {
  zones: DnsZoneSummary[];
  defaultZoneId: string | null;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Backward compatible: an unconfigured token yields no manageable zones, so
  // the client falls back to its single-zone behavior.
  if (!cloudflareConfigured()) {
    return NextResponse.json({ zones: [], defaultZoneId: null } satisfies DnsZonesResponse);
  }

  try {
    const zones = await listZones();
    const summaries = zones
      .map((zone) => ({ id: zone.id, name: zone.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return NextResponse.json({
      zones: summaries,
      defaultZoneId: defaultZoneId() ?? null,
    } satisfies DnsZonesResponse);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
